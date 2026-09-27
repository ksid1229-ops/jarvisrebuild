import { describe, expect, it } from "vitest";
import { runShellCommand, shellProgram } from "../src/jobs/shell.js";
import { openUrlCommand } from "../src/jobs/open-url.js";
import { runBrowserTask, NOT_INSTALLED_MESSAGE } from "../src/jobs/browser.js";
import type { BrowserModule, BrowserContext, BrowserPage } from "../src/jobs/browser.js";

describe("shell job", () => {
  it("runs a command, captures stdout and exit code (real process, no fake)", async () => {
    const res = await runShellCommand("echo hello-agent", { platform: "linux" });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello-agent");
    expect(res.timedOut).toBe(false);
  });

  it("a failing command reports its exit code and stderr — never ok", async () => {
    const res = await runShellCommand("echo oops >&2; exit 3", { platform: "linux" });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("oops");
  });

  it("a command past the timeout is killed and marked timedOut", async () => {
    const res = await runShellCommand("sleep 1", { timeoutMs: 60, platform: "linux" });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  it("the Windows program is PowerShell with the right flags", () => {
    const { program, args } = shellProgram("win32");
    expect(program).toBe("powershell.exe");
    expect(args("Get-Date")).toEqual(["-NoProfile", "-NonInteractive", "-Command", "Get-Date"]);
  });
});

describe("open_url job", () => {
  it("maps the launcher per platform (Windows: cmd /c start)", () => {
    expect(openUrlCommand("win32", "https://x.example")).toEqual({ program: "cmd.exe", args: ["/c", "start", "", "https://x.example"] });
    expect(openUrlCommand("darwin", "https://x.example").program).toBe("open");
    expect(openUrlCommand("linux", "https://x.example").program).toBe("xdg-open");
  });
});

describe("browser job (honest paths, fake playwright)", () => {
  it("no playwright installed => honest failure with the exact fix, nothing opened", async () => {
    const res = await runBrowserTask({ url: "https://shop.example/checkout" }, {
      importPlaywright: () => Promise.reject(new Error("Cannot find module 'playwright'")),
      chromeProfileDir: "C:/ChromeProfile",
    });
    expect(res.ok).toBe(false);
    expect(res.opened).toBe(false);
    expect(res.note).toBe(NOT_INSTALLED_MESSAGE);
    expect(res.note).toContain("npm install playwright");
  });

  it("no Chrome profile configured => honest refusal (autofill lives in the real profile)", async () => {
    const res = await runBrowserTask({ url: "https://shop.example/checkout" }, {
      importPlaywright: () => Promise.resolve({} as BrowserModule),
      chromeProfileDir: undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.note).toContain("CHROME_PROFILE_DIR");
  });

  it("no url in the job => refused before anything launches", async () => {
    const res = await runBrowserTask({}, { importPlaywright: () => Promise.resolve({} as BrowserModule), chromeProfileDir: "p" });
    expect(res.ok).toBe(false);
    expect(res.note).toContain("no valid http(s) url");
  });

  it("a spend job: opens his Chrome, finds the card field, reports autofill worked — and never types digits", async () => {
    const pressed: string[] = [];
    let cardValue = "";
    const page: BrowserPage = {
      goto: async (url: string) => ({ url: () => url }),
      title: async () => "Checkout — Shop",
      $: async (selector: string) => (selector.includes("cc-number") ? { focus: async () => {} } : null),
      evaluate: async (fn: string) => {
        if (fn.includes("el.value")) return cardValue.replace(/\D/g, "").length >= 4;
        return false;
      },
      keyboard: { press: async (k: string) => { pressed.push(k); cardValue = "**** **** **** 2286"; } },
      waitForTimeout: async () => {},
      url: () => "https://shop.example/checkout",
    };
    const context: BrowserContext = { newPage: async () => page, pages: () => [page], close: async () => {} };
    const launches: { dir: string; opts: Record<string, unknown> }[] = [];
    const pw: BrowserModule = {
      chromium: {
        launchPersistentContext: async (dir: string, opts: Record<string, unknown>) => {
          launches.push({ dir, opts });
          return context;
        },
      },
    };
    const res = await runBrowserTask(
      { url: "https://shop.example/checkout", instructions: "Complete the checkout using Sid's saved card ending 2286 via browser autofill." },
      { importPlaywright: () => Promise.resolve(pw), chromeProfileDir: "C:/Profiles/Sid" },
    );
    expect(res.ok).toBe(true);
    expect(res.opened).toBe(true);
    expect(res.title).toBe("Checkout — Shop");
    expect(res.cardFieldFound).toBe(true);
    expect(res.cardFilled).toBe(true);
    expect(res.note).toContain("2286");
    expect(res.note).toContain("NOT submitted");
    // Autofill is Chrome's own suggestion UI: keyboard only, no typing.
    expect(pressed).toEqual(["ArrowDown", "Enter"]);
    // His real Chrome, visible, with his profile dir.
    expect(launches[0]!.dir).toBe("C:/Profiles/Sid");
    expect(launches[0]!.opts).toMatchObject({ channel: "chrome", headless: false });
  });

  it("autofill that does not take is reported honestly, page left open", async () => {
    const page: BrowserPage = {
      goto: async (url: string) => ({ url: () => url }),
      title: async () => "Pay",
      $: async () => ({ focus: async () => {} }),
      evaluate: async () => false,
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
      url: () => "https://shop.example/pay",
    };
    const context: BrowserContext = { newPage: async () => page, pages: () => [page], close: async () => {} };
    const pw: BrowserModule = { chromium: { launchPersistentContext: async () => context } };
    const res = await runBrowserTask(
      { url: "https://shop.example/pay", instructions: "pay with card 2286" },
      { importPlaywright: () => Promise.resolve(pw), chromeProfileDir: "p" },
    );
    expect(res.ok).toBe(true);
    expect(res.cardFilled).toBe(false);
    expect(res.note).toContain("did not fill");
    expect(res.note).toContain("one-tap autofill");
    expect(res.note).toContain("Nothing was typed");
  });
});
