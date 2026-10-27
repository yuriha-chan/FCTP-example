# Browser-backed CLI

`node scripts/browser.mjs` is the canonical role gameplay interface for the active browser-backed run. It drives the real FCTP HTML/JavaScript client through visible controls. The adapter does not call application functions or construct gameplay HTTP requests. `run/browser.mjs` remains a compatibility wrapper. Do not use `node run/game.mjs` as a parallel gameplay path for active roleplay; that CLI and its API manuals are historical provenance and remain for supervisor/archive tooling. Board and observer archive commands are separate tools, not browser gameplay commands.

## Install and build

Use Node 24 LTS and npm. From the repository root:

```sh
npm ci
npx playwright install chromium
npx playwright install-deps chromium
npm run build
```

Playwright's Chromium and host libraries are required. The host browser libraries have been installed for this environment. The compiled build is required before the CLI can start: the worker imports `dist/apps/browser-harness/index.js`, `dist/apps/demo/client-server.js`, and the generated client bundle. Rebuild after changing TypeScript/client sources.

## Roles and session lifecycle

The CLI accepts `player-1` through `player-5` and `administrator-1` through `administrator-3`. It reads `run/runtime-config.json` and only that role's existing credential file under `run/runtime/<runId>/<role>/credentials.json`; administrator roles map to `admin-1` through `admin-3` credential directories. Each opened role gets its own detached daemon, Chromium browser context, page, ephemeral static client server, and socket. The page state persists across separate CLI invocations for that role. Different roles have isolated sessions and cannot share page memory. `open` reuses an already running role session; `close` shuts down that role's active daemon, browser, and static server.

The worker starts only the static server for the actual client bundle, on an ephemeral loopback port. It uses the origins and public Actor IDs from run config; it does not start Authority/Territory game services. The runtime config and role credential files must already exist and identify the configured own Player/Vessel or assigned administrator secret.

To isolate config/runtime files for a test run, set `FCTP_BROWSER_CONFIG_ROOT` to a directory path relative to the repository root (or an absolute path). Put `runtime-config.json` and the usual `runtime/<runId>/<role>/credentials.json` tree below that root. The compiled imports and client assets remain rooted in the repository. With no override, the CLI uses `run/`.

## Commands

```text
node scripts/browser.mjs <role> open
node scripts/browser.mjs <role> view
node scripts/browser.mjs <role> fill <ref> <text>
node scripts/browser.mjs <role> select <ref> <value>
node scripts/browser.mjs <role> click <ref>
node scripts/browser.mjs <role> submit <ref>
node scripts/browser.mjs <role> batch '<JSON array>'
node scripts/browser.mjs <role> back
node scripts/browser.mjs <role> reload
node scripts/browser.mjs <role> close
```

`open` starts a role session if needed, applies that role through the visible **Browser session** form, and prints the page. `view` prints a fresh snapshot. `fill` fills a visible input/textarea; `select` selects a visible option; `click` activates a visible button or link; `submit` uses the visible submit control's actual form submission and browser validation/events. These operations print the resulting live snapshot. `back` uses browser history. `reload` reloads the page and reapplies the same role through the session form with fresh refs. `close` ends the active browser and static server; call it while that role daemon is running.

Example:

```sh
node scripts/browser.mjs player-2 open
node scripts/browser.mjs player-2 view
```

Use refs printed by the latest snapshot. Single operations replace the prior ref set. Batch accepts 1–32 `{command,ref,value?}` steps (`value` is required only for `fill`/`select`), applies them sequentially against the starting handles, settles after each, and returns one fresh final snapshot. Example: `node scripts/browser.mjs player-2 batch '[{"command":"fill","ref":"<name-ref>","value":"Ada"},{"command":"select","ref":"<choice-ref>","value":"b"},{"command":"submit","ref":"<submit-ref>"}]'`. Validate all syntax before acting. If a step fails, later steps are skipped, starting refs are invalidated, and the error identifies the failing step and possible partial execution; no rollback occurs. Controls created/replaced during a batch need a later snapshot. Hidden, detached, disabled, wrong-kind, or stale controls fail rather than resolving elsewhere. Refs are compact session/generation/ordinal tokens, never DOM identifiers.

### Saving and narrowing CLI output

For longer sessions, retain full snapshots and mutation results in the launch-provided `ROLE_DIR`, the existing private directory assigned to your role. Do not write into historical run directories or a shared temporary directory. Redirect to a temporary file and move it into place only on success, leaving stderr visible and the previous known-good snapshot intact if capture fails:

```sh
ROLE_DIR='<launch-provided role-private directory>'
node scripts/browser.mjs player-2 view > "$ROLE_DIR/browser.snapshot.tmp" && mv "$ROLE_DIR/browser.snapshot.tmp" "$ROLE_DIR/browser.snapshot.txt"
sed -n '/Registry/,+24p' "$ROLE_DIR/browser.snapshot.txt"
```

Choose the heading and line range that match the rendered content you need. If a section is missing from this excerpt, inspect the full snapshot or capture a fresh one; an excerpt does not establish that the section is absent. Save mutation output as well, since it contains the fresh snapshot and refs:

```sh
cp "$ROLE_DIR/browser.snapshot.txt" "$ROLE_DIR/browser.before.txt"
REF='<ref from the latest full snapshot>'
node scripts/browser.mjs player-2 click "$REF" > "$ROLE_DIR/browser.after.tmp" && mv "$ROLE_DIR/browser.after.tmp" "$ROLE_DIR/browser.after.txt" && diff -u "$ROLE_DIR/browser.before.txt" "$ROLE_DIR/browser.after.txt"
```

`diff` exit status 1 means there are differences; a status greater than 1 means the comparison failed. Chain capture, move, and diff with `&&` so a failed capture cannot compare a stale after-file. Operations invalidate prior refs on success and batch failure, even when output is redirected, piped, or trimmed. Use refs from the newest full saved output before the next operation; unchanged text in a diff does not authorize reuse of an old ref. For a quick excerpt directly from the CLI, `set -o pipefail` preserves browser command failures through the pipeline:

```sh
set -o pipefail
node scripts/browser.mjs player-2 view | sed -n '/Registry/,+24p'
```

Use a direct pipeline only to inspect output, not as the source of refs for an action; capture a new full snapshot before acting. Keep stderr visible and inspect the full saved output when errors or unavailable reasons could affect an action. These techniques apply only to rendered client output; do not use HTTP/DOM bypasses or inspect credential stores or other role notes. The [gameplay manual](../run/manuals/browser.md#save-and-inspect-snapshots) has the same snapshot workflow in operator context.

Ordinary visible input/select values appear in snapshots as page content (for example, a selected URI, count, or textarea value). Password inputs and controls whose labels/names indicate password, secret, token, or credential are shown as `[REDACTED]`; known values entered into sensitive fields are also masked if echoed elsewhere on the page and are redacted from worker errors. The run adapter bootstraps credentials internally, without putting them in CLI arguments or snapshots. Do not pass credentials or other secrets to `fill`: shell command arguments may be visible to local process inspection. The session form clears its credential field after applying the session.

## Client behavior and boundaries

The page's **Role / Player URI / Vessel URI / Credential / Apply session** form is the session entry point. A Player session must use its own configured Player and Vessel and native credential. Administrator roles use their assigned service credential; they do not receive another role's credential. `session-status` reports role and optional identity, not secrets. Session state is held in page memory; `reload` in this CLI explicitly reapplies the same role using fresh visible refs.

After applying a Player session, refresh Registry/A/B action discovery and choose only visible enabled actions. The browser client owns authentication scope, request construction, action semantics, and server calls. Delivery/acceptance status does not prove business completion. Administrator views expose their scoped controls; a session form is not the former collection of separate administrator password inputs. See [the client walkthrough](client-walkthrough.md) for page sections.

The static client server receives public service origins and Actor IDs only. The worker keeps the role credential in its process. The Unix socket and role directory are restricted, audit records contain operation metadata but not values or rendered text, and CLI output is the live rendered page. A role's browser session is distinct from board identities, `agent-board`, and observer/archive access.

## Verification status and limitations

The bounded broad gate `timeout 180s npm test` passed: build (including browser bundle), test-source typechecking, ESLint, and 104 runtime tests, including eight migrated browser CLI adapter tests. CLI spawn checks use canonical tracked `scripts/browser*.mjs` sources. `git diff --check` was clean. Runtime coverage included rendered client controls, restored Player/administrator controls, browser CLI sessions and batching, authoring, and gameplay. This automated evidence does not claim human UI acceptance or full client-flow coverage.

The browser integration checks remain bounded and do not establish every B/admin action or all client flows. The older `run/game.mjs` and `run/manuals/player.md` document the API CLI contract; for active roleplay their gameplay instructions are superseded by this browser boundary and are retained as historical provenance. Supervisor/archive tooling may still use its separately authorized interfaces.
