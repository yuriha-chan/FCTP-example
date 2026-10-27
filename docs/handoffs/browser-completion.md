# Browser-backed CLI completion

## Runtime boundary

The run gameplay CLI drives the actual browser client through Chromium. Its Markdown-like output comes from the rendered DOM, with visible control refs, form values/options, disabled states and masked secrets. All gameplay requests originate in the browser application. Each role has a persistent isolated browser session; the adapter bootstraps its credential through the visible session form.

The shared static client server also serves the demo launcher. Standalone run sessions use the same HTML, CSS and built JavaScript against configured service origins without starting another game world. The old API CLI is retained as historical tooling; active roleplay access guidance selects the browser harness.

## Verified coverage

- Generic DOM navigation/forms, checkbox changes, hidden content exclusion, credential masking, stale refs and session isolation.
- Actual nondefault Player browser production, entry, loading, departure from the current Territory, and mandatory independently verified signed exit.
- Spawned per-role CLI/daemon open, persistent view, UI action execution, reload/bootstrap, distinct Player/admin sessions and cleanup.
- Integrated `timeout 180s npm test`: build, browser bundle, test-source typecheck, ESLint and 77 runtime tests passed.
- Separate locally excluded run adapter checks: 7 tests and scoped ESLint passed.

Exact verification is in `browser-final-verification.md` and `../memos/browser-final-verification.json`. Historical dependency-install failures and partial focused results are superseded by the final isolated gate, not evidence that the live roleplay has been deployed.

## Entry points and remaining live-run boundary

- `node run/browser.mjs <role> open`
- `node run/browser.mjs <role> view`
- `node run/browser.mjs <role> fill <ref> <text>`
- `node run/browser.mjs <role> select <ref> <value>`
- `node run/browser.mjs <role> click <ref>`
- `node run/browser.mjs <role> submit <ref>`
- `node run/browser.mjs <role> back|reload|close`

Read `docs/browser-harness.md` and `run/manuals/browser.md`. Refs belong to the latest returned view and must be refreshed after each operation. `FCTP_BROWSER_CONFIG_ROOT` supports isolated configuration roots; default is the existing `run/` root. No credentials are passed as process arguments during automatic bootstrap.

The roleplay world remains paused at tick 4/12 after three encounter groups. No live restart, deployment, role invocation, tick progression or game-state change was performed by the harness checks. Same-world resumption must preserve stores, keys, credentials, Player/vessel mapping, old failed requests, board history and participant memories. No commit was made.
