# REQUIREMENTS.md

Traceability from the build brief to the implementation and its tests.
Status: **Done** = built and covered by tests; **Built, untested live** = implemented and
unit-tested against fixtures, but never run against real D2L or real Google servers.

## 1. Tracker dashboard

| #   | Requirement                                                       | Where                                              | Tests                               | Status                                                     |
| --- | ----------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| 1.1 | Every course, unit, lesson, assignment/drop box, quiz, discussion | `d2l/parsers/*`, `ui/dashboard/pages/Courses.tsx`  | `parsers.*.test.ts`, `sync.test.ts` | Done                                                       |
| 1.2 | Due dates, points/weight, submission status, grade/feedback       | `parsers/dropbox.ts`, `parsers/grades.ts`          | `parsers.dropbox`, `parsers.misc`   | Done                                                       |
| 1.3 | Today / This week / Overdue view                                  | `common/priority.ts` `bucketOf`, `pages/Today.tsx` | `priority.test.ts`                  | Done                                                       |
| 1.4 | Weekend plan                                                      | `priority.ts` `weekendPlan`                        | `priority.test.ts`                  | Done                                                       |
| 1.5 | Priority score (due date + weight + overdue)                      | `priority.ts` `priorityOf`                         | `priority.test.ts`                  | Done                                                       |
| 1.6 | Per-teacher question list, add and tick off                       | `pages/AiPages.tsx` `QuestionsPage`                | `importer.test.ts` (parsing)        | Done                                                       |
| 1.7 | Manual edits and notes on any item                                | `pages/ItemDetail.tsx`, `merge.ts` `applyOverride` | `merge.test.ts`                     | Done                                                       |
| 1.8 | **Manual edits survive the next sync**                            | `merge.ts`                                         | `merge.test.ts`, `sync.test.ts`     | Done                                                       |
| 1.9 | Import the markdown files as starting state                       | `importer/markdown.ts`, `pages/Misc.tsx`           | `importer.test.ts`                  | Done (files not supplied at build time — see DECISIONS #1) |

## 2. Auto-sync from D2L (read-only)

| #    | Requirement                                            | Where                                            | Tests                                         | Status                                                                                               |
| ---- | ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2.1  | Sync while browsing, and on demand                     | `background/index.ts`                            | —                                             | Built, untested live                                                                                 |
| 2.2  | Use the existing logged-in session                     | `d2l/client.ts` (`credentials: 'include'`)       | —                                             | Built, untested live                                                                                 |
| 2.3  | **Prefer D2L's own JSON endpoints over HTML scraping** | `d2l/endpoints.ts`                               | all parser tests                              | Done                                                                                                 |
| 2.4  | Content tree                                           | `parsers/content.ts`                             | `parsers.content.test.ts`                     | Done                                                                                                 |
| 2.5  | Drop boxes **including ones hidden from the list**     | `parsers/dropbox.ts` `findHiddenFolderIds`       | `parsers.dropbox`, `sync.test.ts`             | Done                                                                                                 |
| 2.6  | Due and end dates                                      | `parsers/common.ts` `parseD2lDate`               | all parser tests                              | Done                                                                                                 |
| 2.7  | Submission status                                      | `parsers/dropbox.ts` `submissionStatusOf`        | `parsers.dropbox.test.ts`                     | Done                                                                                                 |
| 2.8  | Grades and feedback                                    | `parsers/grades.ts`, `applySubmission`           | `parsers.misc`, `sync.test.ts`                | Done                                                                                                 |
| 2.9  | Rubrics (level-4 criteria)                             | `parsers/rubrics.ts` `level4LevelId`             | `parsers.misc.test.ts`                        | Done                                                                                                 |
| 2.10 | Announcements                                          | `parsers/news.ts`                                | `parsers.misc.test.ts`                        | Done                                                                                                 |
| 2.11 | Quizzes                                                | `parsers/quizzes.ts`                             | `parsers.misc.test.ts`                        | Done                                                                                                 |
| 2.12 | Discussions                                            | `parsers/discussions.ts`                         | `parsers.misc.test.ts`                        | Done                                                                                                 |
| 2.13 | Course outlines and evaluation weights                 | `parsers/grades.ts` weights → `course.weights`   | `parsers.misc`, `sync.test.ts`                | Partial — weights come from the gradebook; a PDF/HTML course outline is not parsed (KNOWN_ISSUES #3) |
| 2.14 | **Handles the LDSB → Durham SSO jump**                 | `d2l/sso.ts`                                     | `parsers.misc.test.ts` (link discovery)       | Built, untested live                                                                                 |
| 2.15 | **Never stores passwords**                             | nothing in the codebase reads a credential field | security review, `TESTING.md`                 | Done                                                                                                 |
| 2.16 | **Never submits, posts, or marks read. GET only**      | `endpoints.ts` guards, `client.ts`               | `sync.test.ts` (asserts every request is GET) | Done                                                                                                 |
| 2.17 | Diffs against the last sync, shows what changed        | `merge.ts`, `pages/Misc.tsx` `ChangesPage`       | `merge.test.ts`, `sync.test.ts`               | Done                                                                                                 |

## 3. Answer notes + rubric check

| #   | Requirement                                              | Where                                                      | Tests                                   | Status |
| --- | -------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------- | ------ |
| 3.1 | Pull only the sources the lesson provides, or one I name | `answerNotes.ts`, `parsers/common.ts` `extractSources`     | `parsers.content`, `guardrails.test.ts` | Done   |
| 3.2 | Short bullets + evidence links, every claim traceable    | `answerNotes.ts` `parseNotes`                              | `guardrails.test.ts`                    | Done   |
| 3.3 | Anything not in the source is flagged                    | `collectFlags`, `EVIDENCE_RULE`                            | `guardrails.test.ts`                    | Done   |
| 3.4 | **Must not write finished, submit-ready answers**        | `guardrails.ts` `enforceNotesOnly`                         | `guardrails.test.ts`                    | Done   |
| 3.5 | Rubric check against level-4, says what's missing        | `rubricCheck.ts`                                           | `guardrails.test.ts`                    | Done   |
| 3.6 | Fixes factual errors                                     | `rubricCheck.ts` `factualErrors`                           | `guardrails.test.ts`                    | Done   |
| 3.7 | Suggests edits that keep my wording                      | `RUBRIC_RULE` + `parseFindings` drops edits not in my text | `guardrails.test.ts`                    | Done   |
| 3.8 | Uses `04_style_guide.md` so it sounds like me            | `rubricCheck.ts` `styleGuide`, stored on import            | —                                       | Done   |
| 3.9 | Opinion questions ask which side first                   | `isOpinionQuestion`, `stanceOptions`                       | `guardrails.test.ts`                    | Done   |

## 4. Formatting fixer (Google Docs)

| #   | Requirement                                  | Where                                                         | Tests               | Status               |
| --- | -------------------------------------------- | ------------------------------------------------------------- | ------------------- | -------------------- |
| 4.1 | 4 blank lines between question/answer blocks | `formatter.ts` `planFormatting`                               | `formatter.test.ts` | Done                 |
| 4.2 | Answer directly under its question           | `detectBlocks` + `answer-position` fix                        | `formatter.test.ts` | Done                 |
| 4.3 | Lists and evidence on their own lines        | `split-list` fix                                              | `formatter.test.ts` | Done                 |
| 4.4 | Remove horizontal answer lines and `____`    | `remove-rule`, `remove-underscores`                           | `formatter.test.ts` | Done                 |
| 4.5 | Evidence as links only                       | `linkify-evidence`                                            | `formatter.test.ts` | Done                 |
| 4.6 | **Google Docs API, not DOM automation**      | `gdocs/docsApi.ts`                                            | —                   | Built, untested live |
| 4.7 | Always preview                               | `previewFormatting` is a separate step from `applyFormatting` | `formatter.test.ts` | Done                 |
| 4.8 | Support undo                                 | `undoFormatting`, `UndoRecord` snapshot                       | —                   | Built, untested live |

## 5. Small helpers

| #   | Requirement                                          | Where                                           | Status               |
| --- | ---------------------------------------------------- | ----------------------------------------------- | -------------------- |
| 5.1 | Due-date desktop notifications                       | `background/notifications.ts`                   | Built, untested live |
| 5.2 | "What should I do next"                              | `priority.ts` `nextUp`, Today page + side panel | Done                 |
| 5.3 | Draft an email to my teacher (I send it)             | `ai/helpers.ts` `draftTeacherEmail` → `mailto:` | Done                 |
| 5.4 | End-of-day summary                                   | `ai/helpers.ts` `buildDaySummary` + alarm       | Done                 |
| 5.5 | Copy worksheet to my Drive                           | `gdocs/docsApi.ts` `copyToMyDrive`              | Built, untested live |
| 5.6 | _(proposed)_ Badge count of unseen changes           | `background/index.ts` `updateBadge`             | Done                 |
| 5.7 | _(proposed)_ Sync request log for the privacy review | `SyncRun.requests`, Changes page                | Done                 |
| 5.8 | _(proposed)_ Per-call and per-month cost tracking    | `ai/provider.ts`, Settings                      | Done                 |

## 6. AI provider layer

| #   | Requirement                                                             | Where                                                   | Tests                 | Status |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------- | --------------------- | ------ |
| 6.1 | Provider-agnostic, base URL + key + model per role                      | `settings.ts`, `provider.ts`                            | `ai.provider.test.ts` | Done   |
| 6.2 | Cheap role: sync summaries, tracker updates                             | `helpers.ts` uses `role: 'cheap'`                       | `ai.provider.test.ts` | Done   |
| 6.3 | Strong role: rubric checks, essay feedback                              | `rubricCheck.ts`, `answerNotes.ts` use `role: 'strong'` | —                     | Done   |
| 6.4 | Default OpenAI-compatible (DeepSeek/OpenAI/OpenRouter/Ollama/LM Studio) | `openaiCompatible.ts` + presets                         | `ai.provider.test.ts` | Done   |
| 6.5 | Anthropic adapter                                                       | `anthropic.ts`                                          | `ai.provider.test.ts` | Done   |
| 6.6 | Keys local, encrypted, never logged                                     | `crypto.ts`                                             | `ai.provider.test.ts` | Done   |
| 6.7 | Show which provider receives data before each call                      | `AiDisclosure`, enforced in `complete()`                | `ai.provider.test.ts` | Done   |
| 6.8 | "Local model only" option                                               | `localModelOnly` gate                                   | `ai.provider.test.ts` | Done   |
| 6.9 | Running cost/token estimate per call and per month                      | `estimateCost`, `monthlySpend`                          | `ai.provider.test.ts` | Done   |

## 7. Architecture and delivery

| #   | Requirement                                                  | Status                                      |
| --- | ------------------------------------------------------------ | ------------------------------------------- |
| 7.1 | One MV3 extension, dashboard as a full-page app in a tab     | Done                                        |
| 7.2 | Side panel for in-page actions on D2L and Google Docs        | Done                                        |
| 7.3 | IndexedDB (Dexie) + JSON export/import                       | Done (`backup.test.ts`)                     |
| 7.4 | TypeScript, Vite, React, light/dark themes                   | Done                                        |
| 7.5 | Loads unpacked in Chrome and Opera GX                        | Built, needs manual verification on Windows |
| 7.6 | "Capture debug fixtures" button with redaction               | Done (`parsers.misc.test.ts`)               |
| 7.7 | Required docs present                                        | Done                                        |
| 7.8 | Semantic versioning, release notes with commit/date/checksum | Done (`scripts/pack.mjs`)                   |

## Out of scope (confirmed not built)

Anything that submits work, posts in discussions, or takes quizzes. The read-only guard
actively blocks these URL shapes even if someone later adds a call by mistake.
