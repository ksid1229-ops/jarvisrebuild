import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeVaultPath, syncVault } from "../src/vault-sync.js";
import type { VaultExport } from "../src/http.js";

const cfg = { jarvisUrl: "https://j.example", pcAgentToken: "tok", vaultToken: "vtok", vaultDir: "/vault" };

function fakeExport(payload: VaultExport) {
  return async () => payload;
}

describe("vault path safety", () => {
  it("accepts normal relative paths and rejects escapes", () => {
    expect(safeVaultPath("/vault", "jarvis/facts/fact_1.md")).toBe("/vault/jarvis/facts/fact_1.md");
    expect(safeVaultPath("/vault", "../evil.md")).toBeNull();
    expect(safeVaultPath("/vault", "jarvis/../../evil.md")).toBeNull();
    expect(safeVaultPath("/vault", "/abs.md")).toBeNull();
    expect(safeVaultPath("/vault", "C:\\evil.md")).toBeNull();
    expect(safeVaultPath("/vault", "jarvis/x y.md")).toBeNull(); // spaces are not part of the contract
  });
});

describe("vault sync (real files in a temp dir)", () => {
  it("writes every note, then skips identical ones on the next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    const payload: VaultExport = {
      ok: true,
      count: 3,
      notes: [
        { path: "jarvis/facts/f1.md", markdown: "---\nid: f1\n---\n\nSid hates mornings.\n" },
        { path: "jarvis/facts/f2.md", markdown: "---\nid: f2\n---\n\nAnother fact.\n" },
        { path: "jarvis/wakeups/w1.md", markdown: "---\nid: w1\n---\n\nCall the dentist.\n" },
      ],
    };
    const first = await syncVault({ ...cfg, vaultDir: dir }, { fetchExport: fakeExport(payload) });
    expect(first).toMatchObject({ count: 3, written: 3, skippedUnchanged: 0, rejectedPaths: [] });
    expect(await readFile(join(dir, "jarvis/facts/f1.md"), "utf8")).toContain("Sid hates mornings.");

    const second = await syncVault({ ...cfg, vaultDir: dir }, { fetchExport: fakeExport(payload) });
    expect(second).toMatchObject({ count: 3, written: 0, skippedUnchanged: 3, rejectedPaths: [] });

    // A changed note is rewritten.
    payload.notes[0]!.markdown = "---\nid: f1\n---\n\nSid hates mornings (updated).\n";
    const third = await syncVault({ ...cfg, vaultDir: dir }, { fetchExport: fakeExport(payload) });
    expect(third.written).toBe(1);
    expect(await readFile(join(dir, "jarvis/facts/f1.md"), "utf8")).toContain("updated");
  });

  it("processes EVERY note — 101 of them, not 64 (the first build's bug)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    const notes = Array.from({ length: 101 }, (_, i) => ({ path: `jarvis/facts/f${i}.md`, markdown: `---\nid: f${i}\n---\n\nFact ${i}.\n` }));
    const report = await syncVault({ ...cfg, vaultDir: dir }, { fetchExport: fakeExport({ ok: true, count: 101, notes }) });
    expect(report.written).toBe(101);
    const files = await readdir(join(dir, "jarvis/facts"));
    expect(files.length).toBe(101);
  });

  it("a count mismatch (server said 5, got 4) is a hard error — never a quiet partial sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    await expect(
      syncVault(
        { ...cfg, vaultDir: dir },
        { fetchExport: fakeExport({ ok: true, count: 5, notes: [{ path: "jarvis/a.md", markdown: "a" }] }) },
      ),
    ).rejects.toThrow("processed 1 of 5");
  });

  it("a hostile note path is rejected loudly and the rest still sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    const report = await syncVault(
      { ...cfg, vaultDir: dir },
      {
        fetchExport: fakeExport({
          ok: true,
          count: 2,
          notes: [
            { path: "jarvis/../../escape.md", markdown: "bad" },
            { path: "jarvis/ok.md", markdown: "good" },
          ],
        }),
      },
    );
    expect(report.rejectedPaths).toEqual(["jarvis/../../escape.md"]);
    expect(report.written).toBe(1);
    expect(await readFile(join(dir, "jarvis/ok.md"), "utf8")).toBe("good");
  });

  it("a failed export (bad payload) throws with the payload excerpt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    await expect(
      syncVault({ ...cfg, vaultDir: dir }, { fetchExport: (async () => ({ raw: "not json" }) as never) }),
    ).rejects.toThrow("did not return a valid payload");
  });

  it("an existing file with different content is overwritten (Jarvis is the source of truth)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    await mkdir(join(dir, "jarvis"), { recursive: true });
    await writeFile(join(dir, "jarvis/edits.md"), "Sid edited this in Obsidian", "utf8");
    const report = await syncVault(
      { ...cfg, vaultDir: dir },
      { fetchExport: fakeExport({ ok: true, count: 1, notes: [{ path: "jarvis/edits.md", markdown: "the canonical text" }] }) },
    );
    expect(report.written).toBe(1);
    expect(await readFile(join(dir, "jarvis/edits.md"), "utf8")).toBe("the canonical text");
  });
});
