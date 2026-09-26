import type { SourceRef } from '../../common/types';

/** D2L serialises dates as ISO-8601 UTC strings, or null. */
export function parseD2lDate(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export interface RichText {
  Text?: string | null;
  Html?: string | null;
}

export function richTextToPlain(rt: RichText | string | null | undefined): string {
  if (!rt) return '';
  if (typeof rt === 'string') return stripHtml(rt);
  if (rt.Text) return rt.Text.trim();
  if (rt.Html) return stripHtml(rt.Html);
  return '';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EXT_KIND: Record<string, SourceRef['kind']> = {
  pdf: 'pdf',
  ppt: 'slides',
  pptx: 'slides',
  doc: 'doc',
  docx: 'doc',
  mp4: 'video',
  mov: 'video',
};

export function classifySource(url: string, title = ''): SourceRef['kind'] {
  const lower = url.toLowerCase();
  if (/docs\.google\.com\/presentation/.test(lower)) return 'slides';
  if (/docs\.google\.com\/document/.test(lower)) return 'doc';
  if (/drive\.google\.com/.test(lower)) return 'doc';
  if (/youtube\.com|youtu\.be|vimeo\.com/.test(lower)) return 'video';
  const ext = lower.split('?')[0].split('#')[0].split('.').pop() ?? '';
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  if (/^https?:/.test(lower)) return /slide|deck/i.test(title) ? 'slides' : 'link';
  return 'unknown';
}

/** Pull every link out of an HTML description so a lesson's own sources are known. */
export function extractSources(html: string | null | undefined, baseOrigin: string): SourceRef[] {
  if (!html) return [];
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:'))
      continue;
    const url = raw.startsWith('http')
      ? raw
      : `${baseOrigin}${raw.startsWith('/') ? '' : '/'}${raw}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = stripHtml(m[2]) || url;
    out.push({ kind: classifySource(url, title), title, url });
  }
  // Bare Google Docs URLs pasted as text, not as links.
  const bare = /https?:\/\/docs\.google\.com\/[^\s"'<>)]+/gi;
  while ((m = bare.exec(stripHtml(html))) !== null) {
    const url = m[0].replace(/[.,]$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ kind: classifySource(url), title: 'Google Doc', url });
  }
  return out;
}

/** D2L content topic types. 1 = File/HTML, 3 = Link, others are activity links. */
export const TOPIC_TYPE = { FILE: 1, LINK: 3 } as const;

/**
 * Activity links inside content point at quizzes/dropboxes/discussions via Url.
 * Recognising these is how we find dropboxes that are hidden from the list page.
 */
export function detectActivityLink(
  url: string | null | undefined,
): { kind: 'assignment' | 'quiz' | 'discussion'; remoteId: string } | null {
  if (!url) return null;
  const patterns: [RegExp, 'assignment' | 'quiz' | 'discussion'][] = [
    [/\/dropbox\/user\/folder_submit_files\.d2l\?db=(\d+)/i, 'assignment'],
    [/\/dropbox\/.*?[?&](?:db|folderId)=(\d+)/i, 'assignment'],
    [/\/quizzing\/user\/quiz_summary\.d2l\?qi=(\d+)/i, 'quiz'],
    [/\/quizzing\/.*?[?&]qi=(\d+)/i, 'quiz'],
    [/\/discussions\/topics\/(\d+)/i, 'discussion'],
    [/\/discussions\/.*?[?&]tId=(\d+)/i, 'discussion'],
  ];
  for (const [re, kind] of patterns) {
    const m = re.exec(url);
    if (m) return { kind, remoteId: m[1] };
  }
  return null;
}
