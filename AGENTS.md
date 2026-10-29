# NovelType maintenance

This repository is the canonical source for NovelType. Keep changes scoped to the Windows novel typing application.

- User data lives in `%APPDATA%/NovelType`. Never include it, credentials, private novels, local screenshots or test profiles in Git or release packages.
- Preserve the data path and existing book format on upgrades. Do not delete user data when updating or uninstalling.
- Typing is case-insensitive, but punctuation and whitespace are significant. Display and retain the original text and the user's exact input.
- Continuous typing must preserve focus across paragraph boundaries. Scrolling must neither change practice position nor request translation.
- AI work starts only after user action, prepares at most the current and next segment, and stops scheduling on pause/error/context change. Never add hidden automatic retries.
- Keep Electron context isolation and sandbox enabled; use the narrow preload API. Do not expose keys to the renderer or logs.
- Test with isolated temporary data and simulated APIs. `test/packaged-smoke.cjs` must never use the real user profile.
- Before a release run `npm test`, `npm run test:desktop`, `npm run dist`, `npm run verify:release` and the packaged smoke test. Report installation/launch limits separately from build success.
- Update package version, lockfile and changelog together. Tags must match package version. Use GitHub Releases for binary assets, not Git commits. See `docs/RELEASING.md`.
