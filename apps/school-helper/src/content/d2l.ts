/**
 * D2L content script.
 *
 * Deliberately minimal. It does NOT scrape or fetch — all reads happen in the
 * service worker against the documented JSON APIs. This script only:
 *   - tells the extension which course page the user is on
 *   - drops a small, unobtrusive launcher for the side panel
 *
 * It never reads form fields, never observes keystrokes, and never clicks.
 */

const ORG_UNIT_RE = /\/d2l\/(?:le\/content|home|lms\/[a-z]+\/[a-z_]+)\/(\d{6,})/;

function currentOrgUnit(): string | undefined {
  const fromPath = ORG_UNIT_RE.exec(location.pathname);
  if (fromPath) return fromPath[1];
  const ou = new URLSearchParams(location.search).get('ou');
  return ou ?? undefined;
}

function announce(): void {
  chrome.runtime
    .sendMessage({
      type: 'page:context',
      url: location.href,
      kind: 'd2l',
      orgUnitId: currentOrgUnit(),
    })
    .catch(() => {});
}

function mountLauncher(): void {
  if (document.getElementById('school-helper-launcher')) return;
  const btn = document.createElement('button');
  btn.id = 'school-helper-launcher';
  btn.type = 'button';
  btn.textContent = 'School Helper';
  btn.setAttribute('aria-label', 'Open the School Helper side panel');
  Object.assign(btn.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483000',
    padding: '8px 14px',
    borderRadius: '999px',
    border: 'none',
    background: '#2563eb',
    color: '#fff',
    font: '500 13px/1 system-ui, sans-serif',
    boxShadow: '0 4px 14px rgba(0,0,0,.25)',
    cursor: 'pointer',
  });
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open:sidepanel' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'open:dashboard', route: '#/today' }).catch(() => {});
  });
  document.body.appendChild(btn);
}

announce();
mountLauncher();

// D2L is a single-page-ish app; re-announce on history changes.
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    announce();
  }
}, 2000);
