# Browser-backed CLI

`node run/browser.mjs` is the role gameplay interface for the active browser-backed run. It drives the real FCTP HTML/JavaScript client through visible controls. The adapter does not call application functions or construct gameplay HTTP requests. Do not use `node run/game.mjs` as a parallel gameplay path for active roleplay; that CLI and its API manuals are historical provenance and remain for supervisor/archive tooling. Board and observer archive commands are separate tools, not browser gameplay commands.

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
node run/browser.mjs <role> open
node run/browser.mjs <role> view
node run/browser.mjs <role> fill <ref> <text>
node run/browser.mjs <role> select <ref> <value>
node run/browser.mjs <role> click <ref>
node run/browser.mjs <role> submit <ref>
node run/browser.mjs <role> back
node run/browser.mjs <role> reload
node run/browser.mjs <role> close
```

`open` starts a role session if needed, applies that role through the visible **Browser session** form, and prints the page. `view` prints a fresh snapshot. `fill` fills a visible input/textarea; `select` selects a visible option; `click` activates a visible button or link; `submit` uses the visible submit control's actual form submission and browser validation/events. These operations print the resulting live snapshot. `back` uses browser history. `reload` reloads the page and reapplies the same role through the session form with fresh refs. `close` ends the active browser and static server; call it while that role daemon is running.

Example:

```sh
node run/browser.mjs player-2 open
node run/browser.mjs player-2 view
```

Use the refs printed by the latest snapshot. Every successful operation that returns a snapshot replaces the prior ref set—including `fill` and `select`. Resolve the desired ref again from that returned snapshot before the next operation. A stale/unknown ref fails; it never resolves to a different control. Disabled, hidden, wrong-kind, or non-submit controls cannot be operated with a ref. Do not cache refs across `view`, navigation, reload, or an action.

Ordinary visible input/select values appear in snapshots as page content (for example, a selected URI, count, or textarea value). Password inputs and controls whose labels/names indicate password, secret, token, or credential are shown as `[REDACTED]`; known values entered into sensitive fields are also masked if echoed elsewhere on the page and are redacted from worker errors. The run adapter bootstraps credentials internally, without putting them in CLI arguments or snapshots. Do not pass credentials or other secrets to `fill`: shell command arguments may be visible to local process inspection. The session form clears its credential field after applying the session.

## Client behavior and boundaries

The page's **Role / Player URI / Vessel URI / Credential / Apply session** form is the session entry point. A Player session must use its own configured Player and Vessel and native credential. Administrator roles use their assigned service credential; they do not receive another role's credential. `session-status` reports role and optional identity, not secrets. Session state is held in page memory; `reload` in this CLI explicitly reapplies the same role using fresh visible refs.

After applying a Player session, refresh Registry/A/B action discovery and choose only visible enabled actions. The browser client owns authentication scope, request construction, action semantics, and server calls. Delivery/acceptance status does not prove business completion. Administrator views expose their scoped controls; a session form is not the former collection of separate administrator password inputs. See [the client walkthrough](client-walkthrough.md) for page sections.

The static client server receives public service origins and Actor IDs only. The worker keeps the role credential in its process. The Unix socket and role directory are restricted, audit records contain operation metadata but not values or rendered text, and CLI output is the live rendered page. A role's browser session is distinct from board identities, `agent-board`, and observer/archive access.

## Verification status and limitations

The generic DOM harness check passed. The actual Player-2 browser integration passed A production, load, departure for the current berth, and the mandatory signed ExitEvent assertion. The spawned CLI test's assertion was corrected to wait for the final gate; that gate is pending, so this guide does not claim a final broad verification. The compiled build must precede browser tests. No browser tests or full gate are part of this documentation checkpoint.

The browser integration currently covers a bounded Player-2/A path and does not establish every B/admin action or all client flows. The older `run/game.mjs` and `run/manuals/player.md` document the API CLI contract; for active roleplay their gameplay instructions are superseded by this browser boundary and are retained as historical provenance. Supervisor/archive tooling may still use its separately authorized interfaces.
