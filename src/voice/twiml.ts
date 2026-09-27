/**
 * Twilio voice webhook: returns TwiML that connects the call to ConversationRelay
 * (speech-to-text in, text-to-speech out) pointed at a WebSocket on the Jarvis
 * Durable Object. dtmfDetection is on so Sid (or a guest) can key a PIN on the
 * keypad instead of saying it aloud.
 */
export function buildConnectTwiml(websocketUrl: string): string {
  const safe = escapeXml(websocketUrl);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<ConversationRelay url="${safe}" ttsProvider="Google" transcriptionProvider="Google" dtmfDetection="true" />` +
    `</Connect>` +
    `</Response>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
