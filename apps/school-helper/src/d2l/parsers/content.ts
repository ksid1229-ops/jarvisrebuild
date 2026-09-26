import type { BoardId, SourceRef, WorkItem } from '../../common/types';
import {
  detectActivityLink,
  extractSources,
  parseD2lDate,
  richTextToPlain,
  type RichText,
} from './common';

/** Valence content module / topic, as returned by /content/root/ and /structure/. */
export interface D2lContentObject {
  Id: number | string;
  Title?: string;
  ShortTitle?: string;
  Type: number; // 0 = module, 1 = topic
  TopicType?: number;
  Url?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  ModuleStartDate?: string | null;
  ModuleEndDate?: string | null;
  ModuleDueDate?: string | null;
  IsHidden?: boolean;
  IsLocked?: boolean;
  Description?: RichText | null;
  DescriptionFileType?: string;
  SortOrder?: number;
  Structure?: D2lContentObject[];
  Activity?: { ActivityType?: number; ActivityId?: string } | null;
  LastModifiedDate?: string | null;
}

export interface ParsedContent {
  items: WorkItem[];
  /** Activity links found in content — these reveal dropboxes hidden from the list. */
  activityLinks: {
    kind: 'assignment' | 'quiz' | 'discussion';
    remoteId: string;
    fromTopic: string;
    title: string;
  }[];
}

export interface ContentParseCtx {
  courseId: string;
  board: BoardId;
  origin: string;
  now?: number;
}

/**
 * Flatten D2L's nested content tree into WorkItems, keeping parent links,
 * dates, and the sources each lesson provides.
 */
export function parseContentTree(
  root: D2lContentObject[] | D2lContentObject,
  ctx: ContentParseCtx,
): ParsedContent {
  const now = ctx.now ?? Date.now();
  const items: WorkItem[] = [];
  const activityLinks: ParsedContent['activityLinks'] = [];
  const nodes = Array.isArray(root) ? root : [root];

  const walk = (
    node: D2lContentObject,
    parentId: string | undefined,
    depth: number,
    index: number,
  ) => {
    if (!node || node.Id == null) return;
    const isModule = node.Type === 0;
    const remoteId = String(node.Id);
    const kind: WorkItem['kind'] = isModule ? (depth === 0 ? 'unit' : 'unit') : 'lesson';
    const id = `${ctx.courseId}:${kind}:${remoteId}`;
    const title = (node.Title ?? node.ShortTitle ?? '(untitled)').trim();

    const descHtml = node.Description?.Html ?? null;
    const sources: SourceRef[] = extractSources(descHtml, ctx.origin);

    // A topic that points at a file/link is itself a source.
    if (!isModule && node.Url) {
      const abs = node.Url.startsWith('http') ? node.Url : `${ctx.origin}${node.Url}`;
      const activity = detectActivityLink(node.Url);
      if (activity) {
        activityLinks.push({ ...activity, fromTopic: id, title });
      } else {
        sources.unshift({ kind: guessKind(abs, title), title, url: abs });
      }
    }

    const item: WorkItem = {
      id,
      courseId: ctx.courseId,
      board: ctx.board,
      kind,
      remoteId,
      title,
      parentId,
      sortOrder: node.SortOrder ?? index,
      url: node.Url
        ? node.Url.startsWith('http')
          ? node.Url
          : `${ctx.origin}${node.Url}`
        : undefined,
      description: richTextToPlain(node.Description) || undefined,
      dueAt: parseD2lDate(node.DueDate ?? node.ModuleDueDate),
      startAt: parseD2lDate(node.StartDate ?? node.ModuleStartDate),
      endAt: parseD2lDate(node.EndDate ?? node.ModuleEndDate),
      status: 'unknown',
      sources: sources.length ? sources : undefined,
      firstSeenAt: now,
      lastSeenAt: now,
      presentInLastSync: true,
    };
    items.push(item);

    const children = node.Structure ?? [];
    children.forEach((child, i) => walk(child, id, depth + 1, i));
  };

  nodes.forEach((n, i) => walk(n, undefined, 0, i));
  return { items, activityLinks };
}

function guessKind(url: string, title: string): SourceRef['kind'] {
  const lower = url.toLowerCase();
  if (/presentation|\.pptx?$/.test(lower) || /slide/i.test(title)) return 'slides';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/document|\.docx?$/.test(lower)) return 'doc';
  if (/youtube|vimeo|\.mp4$/.test(lower)) return 'video';
  return 'link';
}

/** /content/userprogress/ — which topics the student has already visited. */
export interface D2lUserProgress {
  TopicId: number | string;
  CompletionType?: number;
  IsCompleted?: boolean;
  LastVisited?: string | null;
  NumberOfVisits?: number;
}

export function applyProgress(items: WorkItem[], progress: D2lUserProgress[]): WorkItem[] {
  const byTopic = new Map(progress.map((p) => [String(p.TopicId), p]));
  return items.map((item) => {
    if (item.kind !== 'lesson') return item;
    const p = byTopic.get(item.remoteId);
    if (!p) return item;
    return {
      ...item,
      status: p.IsCompleted
        ? 'submitted'
        : (p.NumberOfVisits ?? 0) > 0
          ? 'in-progress'
          : 'not-started',
    };
  });
}
