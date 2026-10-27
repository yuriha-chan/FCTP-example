# Browser batch and compact refs

- Added typed `BrowserSession.batch` and `node run/browser.mjs <role> batch '<JSON array>'`. Batches accept 1–32 strict `{command,ref,value?}` steps, use latest-snapshot handles, revalidate and settle sequentially, then return one snapshot. Failure skips later steps, invalidates starting refs and reports the failing step/possible partial execution without action values; no rollback. Batch timeout is bounded at 30 minutes. Audit records command metadata only.
- Refs are opaque session-prefix/generation/ordinal tokens; stale, detached, hidden, disabled, wrong-kind and cross-session refs fail. Existing single-action freshness and `extractRef` syntax remain compatible. Three browser integration test helpers now parse refs as opaque `[A-Za-z0-9-]+` strings.
- Docs: `docs/browser-harness.md`, `run/manuals/browser.md`; focused coverage: `tests/browser-harness.test.ts`, `tests/browser-cli.test.ts`, `tests/browser-authoring.test.ts`, `tests/browser-client-controls.test.ts`, and `tests/browser-gameplay.test.ts`.
- Checks passed: build, test-source typechecking, scoped ESLint (harness, CLI, and adjusted helpers), batch/CLI tests (4/4), and adjusted Chromium integration tests (3/3).
- Playwright Chromium harness checks passed; no human UI acceptance, broad gate, world launch, or commit was performed.

## Tracked CLI relocation

- Canonical implementation lives in `scripts/browser.mjs`, `scripts/browser-worker.mjs`, and `scripts/browser-transport.mjs`; `run/browser*.mjs` are compatibility wrappers. The CLI derives the repository root from its module URL, keeps default runtime files in `/app/run`, resolves relative `FCTP_BROWSER_CONFIG_ROOT` from the repository root, and imports the same `dist/` modules.
- `tests/browser-cli.test.ts` spawns the canonical tracked CLI. The seven existing parser/config/role/ref/transport tests moved from ignored `run/browser-adapter.test.mjs` into tracked `tests/browser-adapter.test.mjs`.
- Updated `docs/browser-harness.md` and `run/manuals/browser.md` examples to the canonical command. Added `scripts/` to the lint script.
