# AGENTS.md — working on this codebase

Read this before changing anything. It exists so a fresh session does not have to
re-explore the repo.

## The three rules that are not negotiable

1. **Read-only against D2L.** Every request goes through `D2lClient`, which calls
   `assertReadOnly()` and `assertSafePath()`. Never add a POST. Never add a call that
   submits work, posts to a discussion, opens a quiz attempt, or marks anything read.
   Tests in `tests/sync.test.ts` assert this and must keep passing.
2. **No finished answers, ever.** `src/ai/guardrails.ts` is a product rule, not a setting.
   Do not add a flag to bypass it, do not loosen `enforceNotesOnly`, and do not remove the
   `NOT IN SOURCE` flagging. Both schools treat uncited AI writing as academic dishonesty.
3. **Manual edits survive sync.** `src/common/merge.ts` is the only place that writes
   synced fields onto stored items. Anything in `item.overrides` is permanent until the
   user releases it. Never bypass `mergeItem` when writing sync results.

## Code map

```
src/
  common/       domain types, Dexie schema, settings, priority scoring, sync merge, crypto
    types.ts      every persisted shape
    db.ts         Dexie tables + export/import (backup)
    settings.ts   defaults, board config, the three seed courses
    priority.ts   priority score, buckets, weekend plan, "what next"
    merge.ts      sync-vs-manual-edit merge + change records  ← the careful bit
    crypto.ts     AES-GCM key storage, secret scrubbing
    messaging.ts  typed message bus
  d2l/
    endpoints.ts  the Valence endpoint map + read-only guards
    client.ts     GET-only cookie-auth fetch, version negotiation, redaction
    sso.ts        LDSB → Durham cross-board session
    sync.ts       the orchestrator: reads everything, merges, diffs
    capture.ts    "Capture debug fixtures" + redaction
    parsers/      one file per D2L resource, all pure functions
    fixtures/     realistic JSON used by the tests
  ai/
    provider.ts   role routing, disclosure, budget/local-only gates, cost log
    openaiCompatible.ts / anthropic.ts   adapters
    guardrails.ts answer-notes and rubric-check rules   ← do not weaken
    answerNotes.ts / rubricCheck.ts / helpers.ts
  gdocs/
    auth.ts       OAuth PKCE via chrome.identity, user-supplied client id
    docsApi.ts    Docs/Drive calls, allow-list, undo records
    formatter.ts  pure planning of the format fixes  ← fully unit tested
  importer/markdown.ts   the seed-file importer
  background/   MV3 service worker, alarms, notifications
  content/      thin content scripts (announce page context only, no scraping)
  ui/           React dashboard + side panel
```

## Conventions

- **Parsers are pure.** Give them JSON in, get domain objects out. No fetching, no Dexie.
  That is what makes them testable without a live D2L.
- **Network lives in the service worker**, not in content scripts. Content scripts only
  report which page is open.
- **Dates** are epoch milliseconds everywhere internally. `parseD2lDate` is the only place
  that reads D2L's ISO strings.
- **Ids** are `${board}:${orgUnitId}` for courses and `${courseId}:${kind}:${remoteId}`
  for items. Stable ids are what make diffing work.
- **Never delete user data.** Items that vanish from D2L are flagged
  `presentInLastSync: false`, not removed.
- **Never log a secret.** Use `scrubSecrets(text, [apiKey])`.

## Adding a new D2L resource

1. Add the endpoint to `src/d2l/endpoints.ts`.
2. Write a pure parser in `src/d2l/parsers/`.
3. Save a realistic fixture in `src/d2l/fixtures/`.
4. Write the test first, against the fixture.
5. Wire it into `syncCourse()` using the `safeRead` helper so a failure cannot kill the sync.

## Before you commit

```bash
npm run lint && npm run typecheck && npm test
```

Then update `docs/HANDOFF.md` and `DECISIONS.md`. Those two files are the contract with
the next session.
