# Final verification handoff

## Acceptance checkpoint

- Ran exactly once: `timeout 180s npm test`; exit status `0`.
- Build passed: TypeScript project builds, browser client TypeScript compilation, and browser esbuild bundle via `apps/demo/build-client.mjs`.
- Test-source typechecking passed for `tests/` and `apps/client/`. ESLint passed for `packages`, `apps` and `tests`.
- Runtime totals: 61 tests reported, 61 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo; runtime duration 12507.775576 ms.
- The host worker retry test passed, as did inbox recovery, message fixtures and all other runtime files. No failing, cancelled, or pending-promise diagnostics were reported.
- Integrated actual-HTTP circulation, outage recovery, and launcher static delivery/shutdown tests passed in this run. The launcher test covered served HTML, stylesheet and JavaScript bundle, credential-free public config, and listener shutdown.
- Build and test typecheck included application and test sources as configured. This gate does not claim full FCTP protocol/profile compliance. No browser/DOM UI test was performed.
- No application code, tests or configuration were changed for this checkpoint.

## Reusable findings

- `FctpServer.resolveRecipientInbox(actorId)` resolves and validates a remote Actor, then persists its public Actor and absolute inbox URI in `remoteActors`. Known recipients use the cached route without refreshing during an outage; unknown recipients need one online resolution. Simulation retains its explicit `registryInbox` override.
- The launcher test resolves relative routes with `new URL(path, base)` and fetches absolute Actor/map references directly. Its HTTP assertions do not test browser behavior.
- Inbox recovery retains the original rejected Activity and deduplication state across restart and avoids requeue on replay; the integrated runtime test passed in this gate.

## Documentation and mechanical checks

- `git diff --check` passed with no output.
- `docs/memos/final-verification.json` parsed successfully as JSON.
