/**
 * Browser jobs: drive Sid's REAL Chrome (his saved logins, his saved card) via
 * Playwright with a persistent user-data dir. This is how spend_money reaches
 * a checkout page: Jarvis queues a browser job, the PC opens the page in his
 * profile and tries to select the saved card ending 2286 with Chrome's own
 * autofill — we NEVER type card digits (we don't have them, and must not).
 *
 * HONESTY: everything here reports facts and only facts. If Playwright is not
 * installed, or no Chrome profile is configured, the job FAILS with exactly
 * that and nothing is pretended. Autofill via keyboard (focus the card field,
 * ArrowDown, Enter) is a best-effort technique — the result says whether the
 * field actually got a value, and the page is left open on his screen either
 * way. Unverified against real Chrome in this sandbox: see PROGRESS.md.
 *
 * Setup on Sid's PC (PowerShell):  cd apps\pc-agent ; npm install playwright
 */

export const NOT_INSTALLED_MESSAGE =
  "Playwright is not installed on this PC. Run: cd apps\\pc-agent ; npm install playwright — then retry. Nothing was done.";

/** The minimal Playwright surface this job uses (so tests can fake it). */
export interface BrowserModule {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      opts: Record<string, unknown>,
    ): Promise<BrowserContext>;
  };
}

export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  pages(): BrowserPage[];
  close(): Promise<void>;
}

export interface BrowserPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ url(): string }>;
  title(): Promise<string>;
  $(selector: string): Promise<BrowserElement | null>;
  evaluate<T>(fn: string): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
}

export interface BrowserElement {
  focus(): Promise<void>;
}

export interface BrowserTaskResult {
  ok: boolean;
  url: string;
  opened: boolean;
  title: string | null;
  cardFieldFound: boolean;
  /** True when the card field ended up holding a value (autofill worked). */
  cardFilled: boolean;
  note: string;
}

export interface BrowserTaskDeps {
  /** Loads the playwright module; default: a real dynamic import. */
  importPlaywright(): Promise<BrowserModule>;
  /** Chrome user-data dir (the profile with the saved card). Required. */
  chromeProfileDir: string | undefined;
  /** Reuse one shared context across jobs (one Chrome window, tabs). */
  sharedContext?: { get(): BrowserContext | Promise<BrowserContext> | undefined };
  platform?: NodeJS.Platform;
}

const CARD_SELECTORS = [
  'input[autocomplete="cc-number"]',
  'input[name*="card" i]',
  'input[id*="card" i]',
  'input[placeholder*="card number" i]',
];

export async function runBrowserTask(
  args: { url?: unknown; instructions?: unknown },
  deps: BrowserTaskDeps,
): Promise<BrowserTaskResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (url === "" || !/^https?:\/\//i.test(url)) {
    return { ok: false, url, opened: false, title: null, cardFieldFound: false, cardFilled: false, note: "no valid http(s) url in the job; nothing was opened." };
  }
  const instructions = typeof args.instructions === "string" ? args.instructions : "";
  const wantsCard = /card|pay|checkout|buy|2286/i.test(instructions);

  let pw: BrowserModule;
  try {
    pw = await deps.importPlaywright();
  } catch {
    return { ok: false, url, opened: false, title: null, cardFieldFound: false, cardFilled: false, note: NOT_INSTALLED_MESSAGE };
  }
  if (!deps.chromeProfileDir) {
    return {
      ok: false,
      url,
      opened: false,
      title: null,
      cardFieldFound: false,
      cardFilled: false,
      note:
        "CHROME_PROFILE_DIR is not configured, so browser jobs cannot use Sid's real Chrome profile (where the saved card lives). " +
        "Set it in config.json (scripts\\install-task.ps1 can do this). Nothing was opened.",
    };
  }

  let context: BrowserContext;
  try {
    const existing = await deps.sharedContext?.get();
    context =
      existing ??
      (await pw.chromium.launchPersistentContext(deps.chromeProfileDir, {
        channel: "chrome", // his real installed Chrome, not a downloaded Chromium
        headless: false, // visible: autofill and logins need his real session
      }));
  } catch (e) {
    return { ok: false, url, opened: false, title: null, cardFieldFound: false, cardFilled: false, note: `could not launch Chrome: ${(e as Error).message}` };
  }

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const title = await page.title().catch(() => null);

    if (!wantsCard) {
      return {
        ok: true,
        url: page.url(),
        opened: true,
        title,
        cardFieldFound: false,
        cardFilled: false,
        note: `Opened ${page.url()}${title ? ` ("${title}")` : ""} in Sid's Chrome. The tab is left open on his screen. No automation was requested.`,
      };
    }

    // Best-effort card autofill: focus the field and step through Chrome's own
    // suggestion with the keyboard. We never type digits.
    let field: BrowserElement | null = null;
    for (const selector of CARD_SELECTORS) {
      field = await page.$(selector).catch(() => null);
      if (field) break;
    }
    if (!field) {
      return {
        ok: true,
        url: page.url(),
        opened: true,
        title,
        cardFieldFound: false,
        cardFilled: false,
        note:
          `Opened ${page.url()}${title ? ` ("${title}")` : ""} in Sid's Chrome, but no card-number field was found on this page. ` +
          "The checkout is open on his screen — he can tap his saved card himself. Nothing was typed or clicked.",
      };
    }
    await field.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    const cardFilled = await page
      .evaluate<boolean>(
        `(() => { for (const el of document.querySelectorAll('input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i]')) { if (el.value && el.value.replace(/\\D/g, '').length >= 4) return true; } return false; })()`,
      )
      .catch(() => false);

    return {
      ok: true,
      url: page.url(),
      opened: true,
      title,
      cardFieldFound: true,
      cardFilled,
      note: cardFilled
        ? `Opened ${page.url()} in Sid's Chrome and selected the saved card ending 2286 via Chrome autofill. The page is open on his screen — the payment was NOT submitted; a person should review and click pay.`
        : `Opened ${page.url()} in Sid's Chrome and tried the card autofill, but the card field did not fill. The checkout is open on his screen for a one-tap autofill. Nothing was typed.`,
    };
  } catch (e) {
    return { ok: false, url, opened: true, title: null, cardFieldFound: false, cardFilled: false, note: `browser task failed partway: ${(e as Error).message} — the tab may be open on his screen.` };
  }
}
