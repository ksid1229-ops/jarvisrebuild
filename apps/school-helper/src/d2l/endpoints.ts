/**
 * D2L Brightspace endpoint map.
 *
 * Two families are used, in this order of preference:
 *  1. Valence LE/LP REST APIs (`/d2l/api/...`) — stable, documented JSON.
 *  2. Same-origin AJAX endpoints the Brightspace pages themselves call
 *     (`/d2l/le/...`) — used only where Valence has no read for it.
 *
 * Every call is a GET against a host the user is already authenticated to.
 * Versions are negotiated at runtime via /d2l/api/versions/.
 */

export const API_VERSIONS = {
  lp: '1.31',
  le: '1.69',
} as const;

export interface EndpointSpec {
  name: string;
  path: string;
  family: 'lp' | 'le' | 'page';
}

export const endpoints = {
  /** Supported API versions — used to negotiate down on older tenants. */
  versions: () => `/d2l/api/versions/`,

  whoAmI: (lp = API_VERSIONS.lp) => `/d2l/api/lp/${lp}/users/whoami`,

  /** Course enrolments for the signed-in user. */
  myEnrollments: (lp = API_VERSIONS.lp) =>
    `/d2l/api/lp/${lp}/enrollments/myenrollments/?orgUnitTypeId=3`,

  orgUnit: (orgUnitId: string, lp = API_VERSIONS.lp) => `/d2l/api/lp/${lp}/courses/${orgUnitId}`,

  /** Full content tree: modules with nested modules and topics. */
  contentRoot: (orgUnitId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/content/root/`,
  contentModule: (orgUnitId: string, moduleId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/content/modules/${moduleId}/structure/`,
  contentTopic: (orgUnitId: string, topicId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/content/topics/${topicId}`,
  /** Per-topic completion / visited state. */
  contentCompletions: (orgUnitId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/content/userprogress/`,

  /** Assignments (dropboxes). Includes ones hidden from the list if linked in content. */
  dropboxFolders: (orgUnitId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/dropbox/folders/`,
  dropboxFolder: (orgUnitId: string, folderId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/dropbox/folders/${folderId}`,
  dropboxSubmissions: (orgUnitId: string, folderId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/dropbox/folders/${folderId}/submissions/`,
  dropboxFeedback: (orgUnitId: string, folderId: string, userId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/dropbox/folders/${folderId}/feedback/${userId}`,

  /** Grades. */
  gradeObjects: (orgUnitId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/grades/`,
  myGradeValues: (orgUnitId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/grades/values/myGradeValues/`,

  /** Quizzes. Read-only listing; the extension never opens or submits an attempt. */
  quizzes: (orgUnitId: string, le = API_VERSIONS.le) => `/d2l/api/le/${le}/${orgUnitId}/quizzes/`,

  /** Discussions. */
  discussionForums: (orgUnitId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/discussions/forums/`,
  discussionTopics: (orgUnitId: string, forumId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/discussions/forums/${forumId}/topics/`,

  /** Announcements. Read via GET only — never marked as read. */
  news: (orgUnitId: string, le = API_VERSIONS.le) => `/d2l/api/le/${le}/${orgUnitId}/news/`,

  /** Rubrics attached to an activity. */
  rubrics: (orgUnitId: string, le = API_VERSIONS.le) => `/d2l/api/le/${le}/${orgUnitId}/rubrics/`,
  objectRubrics: (orgUnitId: string, objectType: string, objectId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/rubrics/${objectType}/${objectId}`,

  /** Calendar gives due dates for items the other reads miss. */
  calendarEvents: (orgUnitId: string, le = API_VERSIONS.le) =>
    `/d2l/api/le/${le}/${orgUnitId}/calendar/events/myEvents/`,

  /** Homepage HTML — used only to find the "My Courses in Other Boards" SSO link. */
  homepage: () => `/d2l/home`,
  courseHome: (orgUnitId: string) => `/d2l/home/${orgUnitId}`,
  contentPage: (orgUnitId: string) => `/d2l/le/content/${orgUnitId}/Home`,
  dropboxListPage: (orgUnitId: string) => `/d2l/lms/dropbox/user/folders_list.d2l?ou=${orgUnitId}`,
} as const;

/** Guard: the extension is read-only. Anything not a GET is a bug. */
export function assertReadOnly(method: string): void {
  if (method.toUpperCase() !== 'GET') {
    throw new Error(
      `School Helper is read-only: refused a ${method.toUpperCase()} request. ` +
        `This build never submits, posts, or marks anything read.`,
    );
  }
}

/** Paths that would mutate state, blocked defensively even for GET. */
const FORBIDDEN_PATTERNS = [
  /\/submit/i,
  /\/attempts?\//i,
  /markasread/i,
  /\/post\b/i,
  /\/delete/i,
  /\/update/i,
  /_d2l_act=/i,
];

export function assertSafePath(url: string): void {
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(url)) {
      throw new Error(`Blocked potentially state-changing URL: ${url}`);
    }
  }
}
