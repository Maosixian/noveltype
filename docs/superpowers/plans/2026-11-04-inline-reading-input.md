# Inline reading input implementation plan

**Goal:** Type directly on the English passage beside its Chinese source, with no second visible text-entry block below it.

**Architecture:** Keep the existing native textarea and TypingSession as the authority for input, selection, exact drafts and saving. Present feedback on the incrementally rendered target characters; position the native input beside the visible caret. Coalesce caret geometry work through animation frames. Follow typing only when necessary; manual scrolling must remain independent of practice and translation.

**Tech stack:** Existing Electron, DOM/CSS and isolated Playwright regression tests. No new runtime dependency or data format.

## Scope and acceptance

- Click the active English passage to focus its existing input. Correct, incorrect, selected and current characters remain visible on the passage.
- Preserve native keyboard editing, required Enter/Tab, case-insensitive matching, exact whitespace/punctuation, accessibility naming, pause and safe saving.
- Preserve continuous focus and the exact next draft across paragraph completion; preserve source alignment and chapter feedback.
- Long passage caret remains visible while typing, including font/viewport changes. Manual scrolling cannot advance position, start translation or constantly snap back.
- Keep Chinese-left/English-right on desktop and existing narrow responsive layout. No input block below the target.
- No real-profile test interaction, provider requests or computer-use tools. Use isolated synthetic fixtures.

## Steps

1. Add `test/inline-typing-smoke.cjs`; demonstrate the old layout fails the inline geometry requirement.
2. Change `app/renderer.js`, the existing stylesheet and reading markup; extract a small helper only if it separates caret layout responsibilities.
3. Verify new keyboard, scrolling, correction and persistence cases; update prior layout assertions to reflect the intentionally replaced input placement.
4. Run unit, desktop and performance suites; inspect synthetic visual evidence and independent code/security review.
5. Update version, lockfile and changelog together. Build and verify installer/ZIP, run isolated packaged tests, and publish through the existing GitHub release workflow.
6. Back up the complete real desktop profile through a verified unpackaged process, install, and verify logical state parity and normal desktop launch. Keep private books and backups outside source control and releases.
