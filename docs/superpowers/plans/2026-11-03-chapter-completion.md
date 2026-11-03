# Chapter Completion Implementation Plan

**Goal:** Show an accurate chapter-end message and the next chapter's name in novel and Bible practice without interrupting continuous typing.

**Architecture:** Derive a chapter index from existing source text at book boundaries. Keep the existing Library schema and account protocol unchanged. Display a separate, nonmodal status card only after a newly typed chapter-ending passage is durably saved; complete paragraph races use the same feedback path.

**Tech Stack:** Existing Electron application, plain JavaScript ES modules, Node test runner, Playwright with isolated synthetic profiles.

## Behavior and boundaries

- Recognize explicit chapter headings conservatively, including Chinese chapter numbers, English Chapter headings, and the Bible's bracketed book/chapter/verse labels.
- Volume/part headings are not chapter completions. Unknown text does not receive invented chapter numbers.
- A chapter descriptor contains `id`, `label`, `start`, `end`, with inclusive segment boundaries. `transitionAt(index)` returns `{completed,next,bookEnd}` at a known chapter end only.
- At a real boundary, show the next label while automatically retaining the existing next-paragraph focus behavior.
- “本章已完成” requires all segments of that chapter to be completed. A skipped portion produces “已到本章末尾”. The last chapter shows the end of the book without inventing another chapter.
- “全书已完成” requires every segment; otherwise use “本书已到结尾”.
- Scrolling, selecting another passage, initializing a restored completed draft, and fetching translations do not create completion events.
- Saving failure leaves the existing error state intact. Delayed saves are bound to the originating book and view and cannot show feedback for a different context.
- Full paragraph race completion can show the chapter message. Defense and short map excerpts cannot.
- Chapter detection never rewrites source text, translates headings, invokes a provider, or scans an entire book on each keystroke.
- Motion follows the existing full/reduced/off setting; the information remains available with motion disabled.

## Work packages

- [x] Add failing chapter index tests in `test/chapters.test.mjs`, including ambiguous prose, canonical Bible book transitions, prefaces, final chapters, and a 60k-segment synthetic book.
- [x] Implement `app/chapters.mjs` with one-time indexing and bounded lookups. Run `node --test test/chapters.test.mjs`.
- [x] Add feedback state tests before implementing `app/chapter-feedback.mjs`; integrate with `app/renderer.js` and the validated full-race callback in `app/games-ui.mjs`.
- [x] Add chapter card markup/styles to the current layout; keep the existing error notice independent and preserve input focus and scroll behavior.
- [x] Run a failing then passing `test/chapter-smoke.cjs` using synthetic books and cached alignments. Cover novel/Bible transitions, skipped passages, game transitions, persistence failures, delayed results, restart, and reduced motion.
- [x] Add new runtime files to both release allowlists; update version and lockfile together to 1.9.0, changelog, and user instructions.
- [x] Run `npm ci`, `npm test`, `npm run test:desktop`, `npm run test:performance`, `npm run dist`, `npm run verify:release`, and the packaged smoke test. All tests use temporary profiles and simulated APIs.
- [x] Review the diff for unrelated changes, private content, unsafe HTML, main-process privileges, and API side effects; resolve findings before committing.
- [ ] Push the feature branch, create and attach the PR, wait for required CI, merge, tag the matching version, and verify Release assets and their checksums.
- [ ] Gracefully close the installed application only for the update, back up the complete latest data directory and verify hashes, install, check version and merged book/progress parity, preserve unresolved sync conflicts, and reopen the app.

The existing unrelated working-tree changes and all user books, settings, credentials, and local evidence remain excluded from the feature commit and release artifacts.
