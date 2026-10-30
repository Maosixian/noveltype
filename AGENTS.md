# NovelType maintenance

This repository is the canonical source for NovelType. Keep changes scoped to the Windows novel typing application.

- User data lives in `%APPDATA%/NovelType`. Never include it, credentials, private novels, local screenshots or test profiles in Git or release packages.
- Preserve the data path and existing book format on upgrades. Do not delete user data when updating or uninstalling.
- Since 1.3.0, current state includes `library.journal.jsonl` and its bound `library.journal-base.json`. Read current state through `Library` or export; never treat raw `library.json` alone as the latest state. Back up the complete data directory before local maintenance. Older versions require an exported merged backup before downgrade.
- Typing is case-insensitive, but punctuation and whitespace are significant. Display and retain the original text and the user's exact input.
- Continuous typing must preserve focus across paragraph boundaries. Scrolling must neither change practice position nor request translation.
- AI work starts only after user action, prepares at most the current and next three segments, and stops scheduling on pause/error/context change. Never add hidden automatic retries. This three-segment buffer was explicitly requested by the user on 2026-10-30.
- Routine progress and translation saves must not rewrite or return the entire book library. Preserve acknowledged changes across restart, failed writes, and backup recovery; validate using a large synthetic library.
- Keep Electron context isolation and sandbox enabled; use the narrow preload API. Do not expose keys to the renderer or logs.
- Test with isolated temporary data and simulated APIs. `test/packaged-smoke.cjs` must never use the real user profile.
- Before a release run `npm test`, `npm run test:desktop`, `npm run dist`, `npm run verify:release` and the packaged smoke test. Report installation/launch limits separately from build success.
- Update package version, lockfile and changelog together. Tags must match package version. Use GitHub Releases for binary assets, not Git commits. See `docs/RELEASING.md`.
