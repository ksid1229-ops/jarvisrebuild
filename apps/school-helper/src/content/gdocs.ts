/**
 * Google Docs content script.
 *
 * The Docs editor is canvas-based, so nothing here touches the document
 * content. It only reports the open document id so the side panel can offer
 * the formatter, which then works through the Docs API.
 */

function docId(): string | undefined {
  const m = /\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(location.pathname);
  return m ? m[1] : undefined;
}

function accountSlot(): string {
  const m = /\/document\/u\/(\d+)\//.exec(location.pathname);
  return m ? `/u/${m[1]}` : '/u/0';
}

chrome.runtime
  .sendMessage({
    type: 'page:context',
    url: location.href,
    kind: 'gdocs',
    docId: docId(),
    accountSlot: accountSlot(),
  })
  .catch(() => {});
