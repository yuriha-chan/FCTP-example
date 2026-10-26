# Launcher verification handoff

## Acceptance findings

- Launcher integration requests resolve both absolute Actor/map identifiers and relative routes with `new URL(path, base)`.
- The client HTML references `/styles.css` and `/dist/client/main.js`; the stylesheet and nonempty JavaScript bundle are served over HTTP with successful statuses. The test inspects served content only and does not exercise browser or DOM behavior.
- The generated client configuration contains no default administrator secrets. The lifecycle check confirms the client listener rejects requests after `close()`.
- Inbox quarantine retains the full original Activity in persistent rejected state after restart. Replaying the quarantined Activity remains deduplicated and does not requeue it.

## Changed files and API

- `tests/demo-launcher.test.ts`: URL resolution, static asset response, secret exclusion, and shutdown assertions.
- `tests/inbox-recovery.test.ts`: persisted rejected Activity and replay deduplication assertions.
- `docs/handoffs/launcher-verification.md`: this checkpoint.
- `docs/memos/launcher-verification.json`: structured verification record.
- No production implementation or exported API changed.

## Verification

Sequential command chain passed:

1. `npm run build`
2. `npm run typecheck:tests`
3. `npx tsx --test tests/demo-launcher.test.ts tests/inbox-recovery.test.ts` — 5 tests passed.
4. `npx eslint tests/demo-launcher.test.ts tests/inbox-recovery.test.ts` — passed.

Build compiled application projects and the browser client before bundling. Test-source typechecking included the TypeScript tests and browser client project. Focused runtime tests exercised the built launcher bundle and server-base inbox recovery; no UI testing was performed.
