import { spawn } from "node:child_process";

/**
 * Open a URL in the PC's default browser. This is deliberately DUMB: it opens
 * the page on Sid's screen and reports that the open command ran — it does NOT
 * claim the page loaded, and it automates nothing. Anything smarter is a
 * 'browser' job (Playwright, see browser.ts).
 *
 * Web pages only (audit round 4): http(s) URLs. This is Sid's real desktop
 * browser, so a file: URL would open local files and any other scheme is not a
 * page. The server refuses non-web URLs at queue time too — this is the
 * second, independent check (the job table is D1; rows can predate a fix).
 * The allowlist also makes option injection (a url starting with "-") neatly
 * unreachable, which is why no "--" separator is passed below.
 */

export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

export function openUrlCommand(platform: NodeJS.Platform, url: string): { program: string; args: string[] } {
  if (platform === "win32") return { program: "cmd.exe", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { program: "open", args: [url] };
  return { program: "xdg-open", args: [url] };
}

export function openUrl(url: string, opts: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {}): Promise<{ ok: boolean; detail: string }> {
  if (!isWebUrl(url)) {
    return Promise.resolve({
      ok: false,
      detail: `refused to open '${url}': only http(s) web URLs are opened (this is Sid's real desktop browser).`,
    });
  }
  const { program, args } = openUrlCommand(opts.platform ?? process.platform, url);
  const spawnFn = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    try {
      const child = spawnFn(program, args, { stdio: "ignore", detached: true });
      child.on("error", (e: Error) => resolve({ ok: false, detail: `could not open ${url}: ${e.message}` }));
      child.on("spawn", () => resolve({ ok: true, detail: `asked the default browser to open ${url} (no confirmation the page loaded)` }));
      // Some launchers exit immediately; treat exit 0 as success too.
      child.on("close", (code: number | null) => {
        if (code === 0) resolve({ ok: true, detail: `asked the default browser to open ${url} (no confirmation the page loaded)` });
        else resolve({ ok: false, detail: `browser launcher exited with code ${code}` });
      });
    } catch (e) {
      resolve({ ok: false, detail: `could not open ${url}: ${(e as Error).message}` });
    }
  });
}
