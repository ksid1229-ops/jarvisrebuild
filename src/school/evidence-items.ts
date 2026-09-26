/**
 * Evidence extractors: turn one verified observation batch into typed school
 * items (assignments, quizzes, announcements, lessons) plus standalone grade
 * entries and the enrollment manifest. Reads are defensive — D2L shapes drift,
 * so unknown fields degrade to null/“other” instead of throwing — but never
 * fuzzy: no name matching, no guessing which submission belongs to Sid, no
 * invented deadlines.
 */
import type { SchoolObservationBatch } from "./collector-protocol.js";
import type { JsonValue } from "./signed-request.js";

export type SchoolItemKind =
  | "assignment" | "quiz" | "discussion" | "announcement" | "lesson" | "unit" | "other";

export interface ContentRef {
  /** The Content tile's own view of work that lives on another tile. */
  title: string;
  url: string | null;
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
}

export interface SchoolItem {
  id: string;
  kind: SchoolItemKind;
  courseId: string;
  courseName: string;
  host: string;
  title: string;
  url: string | null;
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  status: string | null;
  submittedAt: string | null;
  grade: number | null;
  gradeMax: number | null;
  weight: number | null;
  feedback: string | null;
  description: string | null;
  descriptionTruncated: boolean;
  ambiguousSubmissions: boolean;
  fetchedAt: string;
  readId: string;
  /** Other tiles' views of this same work: portrayals, never adjudicated. */
  contentRefs: ContentRef[];
}

export interface SchoolGrade {
  id: string;
  courseId: string;
  courseName: string;
  host: string;
  name: string;
  grade: number | null;
  gradeMax: number | null;
  weight: number | null;
  comments: string | null;
  lastModified: string | null;
  fetchedAt: string;
  readId: string;
}

export interface EnrolledCourse {
  id: string;
  name: string;
}

export interface ReadFailure {
  route: string;
  fetchedAt: string;
  status: number;
  /** collectorFailure code from the wire, "refused" for a 403 body, or "unexpected_body". */
  code: string;
}

export interface ExtractedEvidence {
  items: SchoolItem[];
  grades: SchoolGrade[];
  courses: EnrolledCourse[];
  readFailures: ReadFailure[];
}

export type ChangeKind =
  | "new_item" | "removed_item" | "due_date" | "status" | "grade"
  | "feedback" | "weight" | "announcement";

export interface ItemChange {
  kind: ChangeKind;
  summary: string;
  itemId: string;
  courseId: string;
  courseName: string;
  field?: string;
  oldValue?: string | number | null;
  newValue?: string | number | null;
}

const DESC_CAP = 4000;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function iso(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/** Prefer the plain-text variant of a D2L rich-text pair; fall back to stripped HTML. */
function textOf(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (!isRec(v)) return null;
  const plain = str(v.Text);
  if (plain) return plain;
  const html = str(v.Html);
  if (!html) return null;
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function capDescription(text: string | null): { text: string | null; truncated: boolean } {
  if (text === null || text.length <= DESC_CAP) return { text, truncated: false };
  return { text: text.slice(0, DESC_CAP), truncated: true };
}

function itemId(host: string, courseId: string, kind: string, remoteId: string): string {
  return `${host}|${courseId}|${kind}|${remoteId}`;
}

function baseItem(
  batch: SchoolObservationBatch, courseId: string, courseName: string,
  kind: SchoolItemKind, remoteId: string, title: string, fetchedAt: string,
): SchoolItem {
  return {
    id: itemId(batch.host, courseId, kind, remoteId),
    kind, courseId, courseName, host: batch.host, title,
    url: null, dueAt: null, startAt: null, endAt: null,
    status: null, submittedAt: null, grade: null, gradeMax: null,
    weight: null, feedback: null, description: null,
    descriptionTruncated: false, ambiguousSubmissions: false,
    fetchedAt, readId: batch.readId, contentRefs: [],
  };
}

function submissionFolderId(route: string): string | null {
  const m = /\/dropbox\/folders\/([^/]+)\/submissions\/mysubmissions\/$/.exec(route);
  return m?.[1] ?? null;
}

export function extractEvidence(batch: SchoolObservationBatch): ExtractedEvidence {
  const items: SchoolItem[] = [];
  const grades: SchoolGrade[] = [];
  const courses: EnrolledCourse[] = [];
  const readFailures: ReadFailure[] = [];
  const courseId = batch.course?.id ?? "";
  const courseName = batch.course?.name ?? "";
  const host = batch.host;

  const dropboxFolders = new Map<string, SchoolItem>();
  const quizItems = new Map<string, SchoolItem>();
  const submissions = new Map<string, { entity: Rec | null; ambiguous: boolean; fetchedAt: string }>();

  for (const read of batch.routes) {
    const route: string = read.route;
    if (!read.complete) {
      readFailures.push({
        route, fetchedAt: read.fetchedAt, status: read.status,
        code: collectorFailureCode(read.body),
      });
      continue;
    }
    const body: JsonValue = read.body;

    // Protocol ping: no course content, nothing to extract.
    if (route === "/d2l/api/versions/") continue;

    if (route === "/d2l/api/lp/1.43/enrollments/myenrollments/" ||
        route.startsWith("/d2l/api/lp/1.43/enrollments/myenrollments/?")) {
      const enrollmentList = Array.isArray(body)
        ? body
        : isRec(body) && Array.isArray(body.Items) ? body.Items : null;
      if (enrollmentList) {
        for (const entry of enrollmentList) {
          const found = enrollmentCourse(entry);
          if (found) courses.push(found);
        }
      } else {
        readFailures.push({ route, fetchedAt: read.fetchedAt, status: read.status, code: "unexpected_body" });
      }
      continue;
    }

    if (route.endsWith("/dropbox/folders/")) {
      if (!Array.isArray(body)) {
        readFailures.push(unexpected(route, read));
        continue;
      }
      for (const entry of body) {
        if (!isRec(entry)) continue;
        const id = num(entry.Id);
        if (id === null) continue;
        const item = baseItem(batch, courseId, courseName, "assignment", String(id),
          str(entry.Name) ?? `Assignment ${id}`, read.fetchedAt);
        item.url = `https://${host}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${id}&ou=${courseId}`;
        item.dueAt = iso(entry.DueDate);
        const assessment = isRec(entry.Assessment) ? entry.Assessment : null;
        item.gradeMax = num(entry.TotalDenom) ?? (assessment ? num(assessment.ScoreDenominator) : null);
        const desc = capDescription(textOf(entry.CustomInstructions));
        item.description = desc.text;
        item.descriptionTruncated = desc.truncated;
        items.push(item);
        dropboxFolders.set(String(id), item);
      }
      continue;
    }

    const folderId = submissionFolderId(route);
    if (folderId) {
      if (!Array.isArray(body)) {
        readFailures.push(unexpected(route, read));
        continue;
      }
      if (body.length === 1 && isRec(body[0])) {
        submissions.set(folderId, { entity: body[0], ambiguous: false, fetchedAt: read.fetchedAt });
      } else if (body.length === 0) {
        submissions.set(folderId, { entity: null, ambiguous: false, fetchedAt: read.fetchedAt });
      } else {
        submissions.set(folderId, { entity: null, ambiguous: true, fetchedAt: read.fetchedAt });
      }
      continue;
    }

    if (route.endsWith("/news/")) {
      if (!Array.isArray(body)) {
        readFailures.push(unexpected(route, read));
        continue;
      }
      for (const entry of body) {
        if (!isRec(entry)) continue;
        if (entry.IsPublished === false) continue; // D2L's own visibility flag
        const id = num(entry.Id);
        if (id === null) continue;
        const item = baseItem(batch, courseId, courseName, "announcement", String(id),
          str(entry.Title) ?? `Announcement ${id}`, read.fetchedAt);
        item.url = `https://${host}/d2l/le/news/${courseId}/${id}/view`;
        item.startAt = iso(entry.StartDate);
        item.endAt = iso(entry.EndDate);
        const desc = capDescription(textOf(entry.Body));
        item.description = desc.text;
        item.descriptionTruncated = desc.truncated;
        items.push(item);
      }
      continue;
    }

    if (route.endsWith("/quizzes/")) {
      const quizList = Array.isArray(body)
        ? body
        : isRec(body) && Array.isArray(body.Objects) ? body.Objects : null;
      if (!quizList) {
        readFailures.push(unexpected(route, read));
        continue;
      }
      for (const entry of quizList) {
        if (!isRec(entry)) continue;
        if (entry.IsActive === false) continue; // not available to Sid either
        const rawId = num(entry.QuizId) ?? num(entry.Id);
        const strId = typeof entry.QuizId === "string" && entry.QuizId.length > 0 ? entry.QuizId : null;
        const id = rawId !== null ? String(rawId) : strId;
        if (id === null) continue;
        const item = baseItem(batch, courseId, courseName, "quiz", id,
          str(entry.Name) ?? `Quiz ${id}`, read.fetchedAt);
        item.url = `https://${host}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${id}&ou=${courseId}`;
        item.dueAt = iso(entry.DueDate);
        item.startAt = iso(entry.StartDate);
        item.endAt = iso(entry.EndDate);
        const instructions = isRec(entry.Instructions) ? entry.Instructions : null;
        const rich = isRec(entry.Description) ? entry.Description : null;
        const desc = capDescription(
          textOf(rich?.Text) ?? textOf(instructions?.Text) ?? textOf(entry.Intro),
        );
        item.description = desc.text;
        item.descriptionTruncated = desc.truncated;
        items.push(item);
        quizItems.set(id, item);
      }
      continue;
    }

    if (route.endsWith("/content/toc") || route.includes("/content/myItems/")) {
      const topics = walkContent(body, host);
      if (topics.length === 0) {
        readFailures.push(unexpected(route, read));
        continue;
      }
      for (const topic of topics) {
        const kind: SchoolItemKind = topic.isModule ? "unit" : "lesson";
        const item = baseItem(batch, courseId, courseName, kind, topic.remoteId, topic.title, read.fetchedAt);
        item.url = topic.url;
        item.dueAt = topic.dueAt;
        item.startAt = topic.startAt;
        item.endAt = topic.endAt;
        items.push(item);
      }
      continue;
    }

    // Grade routes are collected after the loop; anything else complete-but-unknown is a gap.
    if (!route.endsWith("/grades/") && !route.endsWith("/grades/values/myGradeValues/")) {
      readFailures.push({ route, fetchedAt: read.fetchedAt, status: read.status, code: "unhandled_route" });
    }
  }

  // Grade objects (weights + tool linkage) and grade values (scores).
  const gradeObjects = collectGradeObjects(batch);
  const gradeValues = collectGradeValues(batch);
  const linkedGradeObjectIds = new Set<string>();

  for (const gv of gradeValues) {
    const obj = matchGradeObject(gv, gradeObjects);
    const target = obj ? findLinkedItem(obj, dropboxFolders, quizItems) : undefined;
    const score = num(gv.value.PointsNumerator);
    const max = num(gv.value.PointsDenominator);
    if (obj && target) {
      linkedGradeObjectIds.add(obj.key);
      target.grade = score;
      target.gradeMax = max ?? target.gradeMax;
      const w = num(obj.rec.Weight);
      if (w !== null) target.weight = w;
      const comments = textOf(gv.value.Comments) ?? textOf(gv.value.PrivateComments);
      if (comments) target.feedback = comments;
      if (score !== null && target.status === "submitted") target.status = "graded";
      target.fetchedAt = gv.fetchedAt;
    } else {
      const name = str(gv.value.GradeObjectName) ?? `Grade ${gv.identifier}`;
      grades.push({
        id: itemId(host, courseId, "grade", gv.identifier),
        courseId, courseName, host, name,
        grade: score, gradeMax: max,
        weight: obj ? num(obj.rec.Weight) : null,
        comments: textOf(gv.value.Comments) ?? textOf(gv.value.PrivateComments),
        lastModified: iso(gv.value.LastModified),
        fetchedAt: gv.fetchedAt, readId: batch.readId,
      });
      if (obj) linkedGradeObjectIds.add(obj.key);
    }
  }

  // Grade objects with no grade value yet still carry weights onto their items.
  for (const obj of gradeObjects) {
    if (linkedGradeObjectIds.has(obj.key)) continue;
    const target = findLinkedItem(obj, dropboxFolders, quizItems);
    const w = num(obj.rec.Weight);
    if (target && w !== null && target.weight === null) target.weight = w;
  }

  // Cross-surface linkage: a Content topic that links at an assignment or quiz
  // attaches the Content tile's own view (title, url, dates) to that item, so
  // the model sees both portrayals side by side and adjudicates the deadline.
  for (const item of items) {
    if (item.kind !== "lesson" && item.kind !== "unit") continue;
    const link = detectActivityLink(item.url);
    if (!link || link.kind === "discussion") continue;
    const target = link.kind === "assignment"
      ? dropboxFolders.get(link.remoteId)
      : quizItems.get(link.remoteId);
    if (!target || target.id === item.id) continue;
    target.contentRefs.push({
      title: item.title, url: item.url,
      dueAt: item.dueAt, startAt: item.startAt, endAt: item.endAt,
    });
  }

  // Submissions: exactly-one applies; empty means not submitted (D2L said so);
  // multiple is ambiguous and must not be guessed at.
  for (const [folderId, sub] of submissions) {
    const target = dropboxFolders.get(folderId);
    if (!target) continue;
    if (sub.ambiguous) {
      target.ambiguousSubmissions = true;
      continue;
    }
    if (!sub.entity) {
      if (target.status === null) target.status = "not_submitted";
      continue;
    }
    const e = sub.entity;
    const d2l = isRec(e.Feedback) ? e.Feedback : null;
    const subs = Array.isArray(e.Submissions) ? e.Submissions.filter(isRec) : [];
    const firstSub = subs[0];
    const score = (d2l ? num(d2l.Score) : null) ?? num(e.Score);
    const graded = (d2l && d2l.IsGraded === true) || score !== null;
    const statusCode = num(e.Status);
    if (statusCode === 0) {
      target.status = "not_submitted";
    } else if (statusCode === 3 || graded) {
      target.status = "graded";
    } else if (statusCode === 2) {
      target.status = "draft";
    } else if (statusCode === 1 || subs.length > 0 || iso(e.CompletionDate)) {
      target.status = "submitted";
    }
    target.submittedAt = (firstSub ? iso(firstSub.SubmissionDate) : null)
      ?? iso(e.CompletionDate) ?? iso(e.LastModified);
    if (score !== null) target.grade = score;
    const feedback = (d2l ? textOf(d2l.Feedback) : null)
      ?? (isRec(e.Feedback) ? null : textOf(e.Feedback)) ?? textOf(e.feedback);
    if (feedback) target.feedback = feedback;
    target.fetchedAt = sub.fetchedAt;
  }

  return { items, grades, courses, readFailures };
}

const ACTIVITY_PATTERNS: [RegExp, "assignment" | "quiz" | "discussion"][] = [
  [/\/dropbox\/user\/folder_submit_files\.d2l\?db=(\d+)/i, "assignment"],
  [/\/dropbox\/.*?[?&](?:db|folderId)=(\d+)/i, "assignment"],
  [/\/quizzing\/user\/quiz_summary\.d2l\?qi=(\d+)/i, "quiz"],
  [/\/quizzing\/.*?[?&]qi=(\d+)/i, "quiz"],
  [/\/discussions\/topics\/(\d+)/i, "discussion"],
  [/\/discussions\/.*?[?&]tId=(\d+)/i, "discussion"],
];

function detectActivityLink(url: string | null): { kind: "assignment" | "quiz" | "discussion"; remoteId: string } | null {
  if (!url) return null;
  for (const [re, kind] of ACTIVITY_PATTERNS) {
    const m = re.exec(url);
    if (m?.[1]) return { kind, remoteId: m[1] };
  }
  return null;
}

function collectorFailureCode(body: JsonValue): string {
  if (isRec(body)) {
    const code = str(body.collectorFailure);
    if (code) return code;
  }
  return "unknown";
}

function unexpected(route: string, read: { status: number; fetchedAt: string }): ReadFailure {
  return {
    route, fetchedAt: read.fetchedAt, status: read.status,
    code: read.status === 403 ? "refused" : "unexpected_body",
  };
}

function enrollmentCourse(entry: unknown): EnrolledCourse | null {
  if (!isRec(entry)) return null;
  const org = isRec(entry.OrgUnit) ? entry.OrgUnit : entry;
  const id = num(org.Id);
  const name = str(org.Name);
  if (id === null || !name) return null;
  return { id: String(id), name };
}

interface TopicWalk {
  remoteId: string; title: string; isModule: boolean;
  url: string | null; startAt: string | null; endAt: string | null; dueAt: string | null;
}

/**
 * Content comes as the TOC: an array of modules with nested Structure
 * children (Type 0 = module, Type 1 = topic), or a paged { Objects } /
 * { Items } variant. Unknown shapes degrade to nothing rather than guesses.
 */
function walkContent(body: JsonValue, host: string): TopicWalk[] {
  const out: TopicWalk[] = [];
  const pushNode = (node: Rec, isModule: boolean): void => {
    const id = num(node.Id) ?? num(node.ModuleId) ?? num(node.Identifier) ?? num(node.TopicId);
    const title = str(node.Title) ?? str(node.Name);
    if (!title) return;
    const path = str(node.Url);
    out.push({
      remoteId: id !== null ? String(id) : `topic-${out.length}`,
      title, isModule,
      url: path && path.startsWith("/") ? `https://${host}${path}` : null,
      startAt: iso(node.StartDate) ?? iso(node.ModuleStartDate),
      endAt: iso(node.EndDate) ?? iso(node.ModuleEndDate),
      dueAt: iso(node.DueDate) ?? iso(node.ModuleDueDate),
    });
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!isRec(node)) return;
    if (Array.isArray(node.Objects)) { visit(node.Objects); return; }
    if (Array.isArray(node.Items)) { visit(node.Items); return; }
    if (Array.isArray(node.Modules)) {
      for (const mod of node.Modules) {
        if (!isRec(mod)) continue;
        pushNode(mod, true);
        if (Array.isArray(mod.Topics)) visit(mod.Topics);
        if (Array.isArray(mod.Modules)) visit(mod.Modules);
        if (Array.isArray(mod.Structure)) visit(mod.Structure);
      }
      return;
    }
    const kids = Array.isArray(node.Structure) ? node.Structure : null;
    const type = num(node.Type);
    // Type 0 = module, Type 1 = topic; untyped nodes with children are modules.
    const isModule = type === 0 || (type === null && kids !== null);
    pushNode(node, isModule);
    if (kids) visit(kids);
  };
  visit(body);
  return out;
}

interface GradeObject { key: string; rec: Rec }
interface GradeValue { identifier: string; value: Rec; fetchedAt: string }

function collectGradeObjects(batch: SchoolObservationBatch): GradeObject[] {
  const out: GradeObject[] = [];
  for (const read of batch.routes) {
    if (!read.complete || !Array.isArray(read.body)) continue;
    if (!read.route.endsWith("/grades/")) continue;
    // grades/values/myGradeValues/ also ends with "/grades/"? No — it ends with
    // "myGradeValues/". But guard anyway: exact suffix on the path segment.
    if (read.route.endsWith("/grades/values/myGradeValues/")) continue;
    for (const entry of read.body) {
      if (!isRec(entry)) continue;
      const id = entry.Id ?? entry.GradeObjectId ?? entry.Identifier;
      const key = typeof id === "number" ? String(id) : str(id);
      if (key) out.push({ key, rec: entry });
    }
  }
  return out;
}

function collectGradeValues(batch: SchoolObservationBatch): GradeValue[] {
  const out: GradeValue[] = [];
  for (const read of batch.routes) {
    if (!read.complete || !Array.isArray(read.body)) continue;
    if (!read.route.endsWith("/grades/values/myGradeValues/")) continue;
    for (const entry of read.body) {
      if (!isRec(entry)) continue;
      const identifier = entry.GradeObjectIdentifier;
      const key = typeof identifier === "number" ? String(identifier) : str(identifier);
      if (key) out.push({ identifier: key, value: entry, fetchedAt: read.fetchedAt });
    }
  }
  return out;
}

function matchGradeObject(gv: GradeValue, objects: GradeObject[]): GradeObject | undefined {
  return objects.find((o) => o.key === gv.identifier);
}

function findLinkedItem(
  obj: GradeObject,
  folders: Map<string, SchoolItem>,
  quizzes: Map<string, SchoolItem>,
): SchoolItem | undefined {
  const tool = obj.rec.AssociatedTool;
  if (!isRec(tool)) return undefined;
  const toolItemId = tool.ToolItemId;
  const key = typeof toolItemId === "number" ? String(toolItemId) : str(toolItemId);
  if (!key) return undefined;
  return folders.get(key) ?? quizzes.get(key);
}

function fmt(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "unknown";
  return String(v);
}

/** Diff two extractions of the same course: old → next. */
export function diffExtracted(oldE: ExtractedEvidence, nextE: ExtractedEvidence): ItemChange[] {
  const changes: ItemChange[] = [];
  const oldItems = new Map(oldE.items.map((i) => [i.id, i]));
  const nextItems = new Map(nextE.items.map((i) => [i.id, i]));

  for (const next of nextE.items) {
    const prev = oldItems.get(next.id);
    if (!prev) {
      changes.push({
        kind: next.kind === "announcement" ? "announcement" : "new_item",
        summary: next.kind === "announcement"
          ? `New announcement in ${next.courseName}: ${next.title}`
          : `New ${next.kind} in ${next.courseName}: ${next.title}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
      });
      continue;
    }
    if (prev.dueAt !== next.dueAt) {
      changes.push({
        kind: "due_date",
        summary: `Due date changed for ${next.title}: ${fmt(prev.dueAt)} → ${fmt(next.dueAt)}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
        field: "dueAt", oldValue: prev.dueAt, newValue: next.dueAt,
      });
    }
    if (prev.status !== next.status) {
      changes.push({
        kind: "status",
        summary: `Status changed for ${next.title}: ${fmt(prev.status)} → ${fmt(next.status)}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
        field: "status", oldValue: prev.status, newValue: next.status,
      });
    }
    if (prev.grade !== next.grade || prev.gradeMax !== next.gradeMax) {
      changes.push({
        kind: "grade",
        summary: `Grade changed for ${next.title}: ${fmt(prev.grade)}/${fmt(prev.gradeMax)} → ${fmt(next.grade)}/${fmt(next.gradeMax)}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
        field: "grade", oldValue: prev.grade, newValue: next.grade,
      });
    }
    if (prev.feedback !== next.feedback && next.feedback !== null) {
      changes.push({
        kind: "feedback",
        summary: `New feedback on ${next.title}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
        field: "feedback", oldValue: prev.feedback, newValue: next.feedback,
      });
    }
    if (prev.weight !== next.weight) {
      changes.push({
        kind: "weight",
        summary: `Weight changed for ${next.title}: ${fmt(prev.weight)} → ${fmt(next.weight)}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
        field: "weight", oldValue: prev.weight, newValue: next.weight,
      });
    }
  }

  for (const prev of oldE.items) {
    if (!nextItems.has(prev.id)) {
      changes.push({
        kind: "removed_item",
        summary: `${prev.kind} disappeared from ${prev.courseName}: ${prev.title}`,
        itemId: prev.id, courseId: prev.courseId, courseName: prev.courseName,
      });
    }
  }

  const oldGrades = new Map(oldE.grades.map((g) => [g.id, g]));
  for (const next of nextE.grades) {
    const prev = oldGrades.get(next.id);
    if (!prev) {
      changes.push({
        kind: "grade",
        summary: `New grade in ${next.courseName}: ${next.name} = ${fmt(next.grade)}/${fmt(next.gradeMax)}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
        field: "grade", oldValue: null, newValue: next.grade,
      });
      continue;
    }
    if (prev.grade !== next.grade || prev.gradeMax !== next.gradeMax) {
      changes.push({
        kind: "grade",
        summary: `Grade changed in ${next.courseName}: ${next.name} ${fmt(prev.grade)}/${fmt(prev.gradeMax)} → ${fmt(next.grade)}/${fmt(next.gradeMax)}`,
        itemId: next.id, courseId: next.courseId, courseName: next.courseName,
        field: "grade", oldValue: prev.grade, newValue: next.grade,
      });
    }
  }

  return changes;
}
