# NEXT_STEPS.md

Ordered by value. Each item says where to start.

## Right now — things only you can do

1. **Push to your private GitHub repo.**

   ```bash
   gh repo create school-helper --private --source=. --remote=origin --push
   # or
   git remote add origin git@github.com:<you>/school-helper.git && git push -u origin main --tags
   ```

   Then create the GitHub Release from `release/RELEASE-NOTES-1.0.0.md` and attach
   `release/school-helper-1.0.0.zip`.

2. **Load it unpacked in Chrome and Opera GX on your Windows PC** and walk the first-run
   checklist in `docs/HANDOFF.md`.

3. **Capture real fixtures.** Settings → _Capture debug fixtures_ → Sync → _Export fixtures_.
   This is the single highest-value thing you can hand back. Everything in
   `KNOWN_ISSUES.md#1` depends on it.

4. **Drop in the six markdown files** so the importer can be checked against their real layout.

## Next — highest value work

5. **Feed real source text to answer notes** (`KNOWN_ISSUES.md#9`).
   Add a worker-side `fetchTopicText(orgUnitId, topicId)` that GETs the topic HTML and runs
   it through `stripHtml`, and use `docPlainText()` for Google Docs sources. Wire both into
   `AnswerNotesPage.run()` where it currently pushes `title + url`. This is the difference
   between notes that cite the lesson and notes that cite a link.

6. **Harden the parsers with your captured fixtures.** Drop the JSON into
   `src/d2l/fixtures/`, add a test per file, fix what breaks. The parsers are pure functions,
   so this is fast.

7. **Verify the Durham SSO path** and replace the pattern guesses in `src/d2l/sso.ts` with
   the actual link from your homepage HTML.

8. **Course outline parsing** — find the outline topic in the content tree (title matching
   /outline|evaluation|course information/i), pull its HTML, and extract the weights table
   into `course.weights`.

## Later — polish

9. Swap `useLive` for `dexie-react-hooks` `useLiveQuery` to remove the polling.
10. Add Playwright end-to-end tests that load the built extension and drive the dashboard.
11. Per-course colour and teacher editing in the UI (currently seeded from `settings.ts`).
12. An "ask about this" button that turns a rubric-check gap straight into a teacher question.
13. Grade projection: "if I get level 4 on this, my mark becomes X" using `course.weights`.
14. Export the weekend plan to an .ics calendar file.
15. Undo that also restores character formatting (store `textStyle` runs in the snapshot).

## Maintenance

- Re-run `npm run release` before every tag; it gates on lint, tests and the build.
- Keep `docs/HANDOFF.md` and `DECISIONS.md` current at the end of every session.
- Bump `VERSION` **and** `public/manifest.json` together — `scripts/postbuild.mjs` fails
  the build if they drift.
