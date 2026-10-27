# Browser CLI isolated lifecycle checkpoint

## Scope and behavior

- Added `FCTP_BROWSER_CONFIG_ROOT` resolution in `run/browser.mjs` as `runtimeConfigRoot()`. It selects an isolated root for `runtime-config.json` and `runtime/<runId>/...` public/private runtime files, defaulting to the existing `run/` directory. Relative overrides resolve from the repository root, consistently in the CLI and detached worker.
- Both CLI and worker use the same helper for the runtime root. The compiled browser harness import, shared static-client import and client asset root remain repository-root based; no gameplay API bypass was introduced.
- `tests/browser-cli.test.ts` starts real five-Player Authority, A and B factories on dynamically selected loopback ports, provisions Player-2/Player-3 native credentials and signed token digests, writes runtime config/credential fixtures only under a temporary root, then exercises spawned CLI/worker processes.
- The CLI test exercises Player-2 open, a separate-process view, rendered A refresh, rendered Mine through a fresh ref, read-only Territory A ledger verification, reload/rebootstrap, separate Player-3 identity and administrator-1 policy-admin session visibility. Its early `t.after` closes role daemons and fixture services and removes its temporary directory.

## Exports

- `run/browser.mjs`: added exported `runtimeConfigRoot(env = process.env)`.
- Existing command, role-session, path and validation exports are unchanged.

## Verification

- `node --check run/browser.mjs && node --check run/browser-worker.mjs` — passed.
- `npx eslint run/browser.mjs run/browser-worker.mjs` — passed.
- `npm run typecheck:tests -- --pretty false` — passed; includes `tests/` and `apps/client/` sources.
- `npx tsx --test tests/browser-cli.test.ts` — one test run, failed at the administrator role text assertion. The real CLI rendered `Role: policy-admin`, while the test expected `Role: Policy administrator`. Player-2 open/view/A refresh/Mine/read-only ledger assertion/reload and Player-3 open completed first. The emitted administrator view displayed the Policy JSON, Update policy and Update admission controls, and did not display the B or Player controls. The expected role text was corrected to the observed role value after this one focused invocation; the focused test was not rerun.
- The test started Chromium successfully and cleaned up its spawned role daemons, services and temporary config root through `t.after`.

## Final integrated verification status

- The corrected assertion was exercised by the integrated `timeout 180s npm test` run recorded in `docs/handoffs/browser-final-verification.md`: the browser CLI lifecycle test passed, including its cleanup.
- The integrated gate passed all 77 runtime tests. The separately conditional `node --test run/browser-adapter.test.mjs` passed all 7 tests, and scoped ESLint passed for `run/browser.mjs`, `run/browser-worker.mjs`, `run/browser-transport.mjs`, and `run/browser-adapter.test.mjs`.
- This updates the post-correction focused-test status: it passed as part of the integrated runtime suite. The B gameplay/UI scope limit below remains.

## Scope limits

- No root build, package scripts, root configuration, current run configuration, live services/world, role/tick state or commit were changed.
- Focused test status remains unverified after the corrected role-text assertion because the assigned focused run was performed once. No gameplay effect beyond the A Mine operation was exercised; the B daemon was started by the Player fixture but no B gameplay action was clicked.
