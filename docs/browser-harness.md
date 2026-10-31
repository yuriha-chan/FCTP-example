# Browser harness and application transport

`scripts/browser.mjs` is the role harness for a local FCTP run. It has two independent paths:

- **Application commands** (`login`, `logout`, `page`, `action`, `result`) call the client application API directly, return the same JSON page models and action records the browser client consumes, and do not start a browser or worker.
- **DOM commands** (`open`, `view`, `fill`, `select`, `click`, `submit`, `batch`, `back`, `reload`, `close`) open the configured client origin in Chromium and operate visible controls. They are rendering and interaction checks, not a gameplay API.

`scripts/browser-api.mjs` exports `createApplicationTransport({ origin, account, fetch?, clientSession?, onSessionChanged? })`. A successful login returns the application account and a client session token. The transport keeps `{accountId, handle, clientToken}` in memory, validates the configured handle and the returned account binding, resolves the account through authenticated `GET /api/accounts`, and attaches only that session as `Authorization: Bearer` to account requests. The optional `clientSession` resumes a caller-owned session without logging in again, and the optional `onSessionChanged(session | null)` callback lets the caller persist or clear it. The transport never retains passwords or native tokens. Public reads work before login; account-scoped reads and actions fail without a matching session.

## Install and build

Use Node 24 LTS and npm from the repository root:

```sh
npm ci
npx playwright install chromium
npx playwright install-deps chromium
npm run build
```

Application commands do not need Playwright. DOM commands need Chromium and the compiled browser harness. Rebuild after changing TypeScript or client sources.

## Start the local demo

```sh
npm run dev
```

`npm run dev` builds and launches the demo. The launcher binds the authority on `127.0.0.1:4100`, Policy Territory on `4101`, Simulation Territory on `4102`, and the client application on `4103`. The client origin is <http://127.0.0.1:4103>.

State is written under `.fctp-data/` by default. Set `FCTP_DATA_DIR` to choose another directory. The directory contains `authority.store.json`, `policy.store.json`, `simulation.store.json`, `client.store.json`, and signing keys. Restarting with the same data directory preserves accounts, drafts, route plans, pending actions and jobs, and retained observations.

The demo fixture provisions two Players, one governor-bound administrator, and the connected outbound route. These credentials are development fixtures only:

| Account | Handle | Password |
| --- | --- | --- |
| First Player | `@player@<authority-host>` | `demo-player-password` |
| Second Player | `@player-2@<authority-host>` | `demo-player-2-password` |
| Governor | `@governor@<authority-host>` | `demo-governor-password` |

For the default launcher, `<authority-host>` is `127.0.0.1:4100`. The governor is bound to the Home/Registry, Policy, and Simulation administrator credentials. Fixture tokens and resource digests are provisioned server-side; the browser and CLI log in with passwords and do not receive manually injected native tokens.

Administrator service secrets default to `demo-authority-admin`, `demo-policy-admin`, and `demo-sim-admin`. Override them with `DEMO_AUTHORITY_ADMIN_SECRET`, `DEMO_POLICY_ADMIN_SECRET`, and `DEMO_SIM_ADMIN_SECRET`. These service secrets are not browser accounts.

## Runtime configuration

The harness reads `runtime-config.json` from `run/` by default. Set `FCTP_BROWSER_CONFIG_ROOT` to another directory, relative to the repository root or absolute. For a demo run:

```json
{
  "runId": "demo",
  "clientOrigin": "http://127.0.0.1:4103",
  "accounts": [
    {
      "name": "player",
      "handle": "@player@127.0.0.1:4100",
      "homeOrigin": "http://127.0.0.1:4100"
    },
    {
      "name": "player-2",
      "handle": "@player-2@127.0.0.1:4100",
      "homeOrigin": "http://127.0.0.1:4100"
    },
    {
      "name": "governor",
      "handle": "@governor@127.0.0.1:4100",
      "homeOrigin": "http://127.0.0.1:4100"
    }
  ]
}
```

Account names are unique public CLI names using lowercase letters and digits, with optional hyphen-separated segments. `handle` identifies the Home account. `homeOrigin` is optional when the handle's server host is sufficient. The configuration contains no passwords. Sockets, audit records, startup diagnostics, and the saved client session live under `<config-root>/runtime/<runId>/<account>/`. The `client-session.json` file is a private regular file (`0600`) in a private directory (`0700`). It stores the origin, handle, account ID, and client session token, is replaced atomically, and is rejected rather than followed when the path is a symlink or another non-regular file. A saved session is used only when its origin and handle match the runtime configuration.

## Application commands

```text
node scripts/browser.mjs <account> login
node scripts/browser.mjs <account> logout
node scripts/browser.mjs <account> page <path>
node scripts/browser.mjs <account> action '<descriptor JSON>' '<inputs JSON>'
node scripts/browser.mjs <account> result <actionId>
```

`login` reads the password from standard input and strips one trailing newline. Passwords are never accepted as command operands, placed in the runtime configuration, or printed. The login command saves the returned client session to the account's private runtime directory but omits the raw `clientToken` from standard output. Later commands in other processes reuse the saved session. `logout` revokes the saved session and removes the file only after the application accepts the logout. For example:

```sh
read -r -s PASSWORD
printf '%s\n' "$PASSWORD" | node scripts/browser.mjs player login
```

```sh
node scripts/browser.mjs player page /api/accounts
node scripts/browser.mjs player page /api/servers
```

`page` reads an application path and prints the parsed JSON returned by the client application. A signed-in account's scope is appended from the configured handle and the request carries that account's client session; a caller-supplied `accountId` is replaced, not trusted. Public reads such as `/api/servers` and unscoped `/api/explore/places` work before login.

`action` sends an `ActionDescriptor` and an inputs object. The descriptor must have no blockers, use `POST`, and target a same-origin `/api` path with no query, fragment, userinfo, or world proxy. Redirects are refused. The configured account scope and client session are attached. A conflicting `accountId` or another account's logout path is rejected; password login uses the dedicated `login` command. A successful logout action clears the saved session. Example:

```sh
node scripts/browser.mjs player action \
  '{"id":"refresh-explore","label":"Refresh explore","endpoint":"/api/explore/refresh","method":"POST","inputs":[],"blockers":[]}' \
  '{}'
```

```sh
node scripts/browser.mjs player result 'action:<id>'
```

`result` reads one retained action record for the configured account scope. It does not refresh or contact a world service.

Application command failures are bounded and readable. They include the HTTP status or a short reason, but never a password, client session token, or native token.

### Transport use in scripts

```js
import { createApplicationTransport } from './scripts/browser-api.mjs';

const transport = createApplicationTransport({
  origin: 'http://127.0.0.1:4103',
  account: { name: 'player', handle: '@player@127.0.0.1:4100', homeOrigin: 'http://127.0.0.1:4100' },
  onSessionChanged: async (session) => {
    // Persist or clear the caller-owned {accountId, handle, clientToken} session.
  }
});

await transport.login('demo-player-password');
const servers = await transport.page('/api/servers');
const places = await transport.action({
  id: 'refresh', label: 'Refresh', endpoint: '/api/explore/refresh', method: 'POST', inputs: [], blockers: []
});
console.log(places.data);
```

The optional `fetch` argument injects a compatible fetch implementation for tests or bounded clients. The optional `clientSession` argument resumes a saved session. Concurrent transports with different accounts keep independent sessions and never share tokens.

## DOM rendering commands

```text
node scripts/browser.mjs <account> open
node scripts/browser.mjs <account> view
node scripts/browser.mjs <account> fill <ref> <text>
node scripts/browser.mjs <account> select <ref> <value>
node scripts/browser.mjs <account> click <ref>
node scripts/browser.mjs <account> submit <ref>
node scripts/browser.mjs <account> batch '<JSON array>'
node scripts/browser.mjs <account> back
node scripts/browser.mjs <account> reload
node scripts/browser.mjs <account> close
```

`open` starts a detached worker for that account if none is running and prints the rendered page from the configured `clientOrigin`. The worker opens only the application origin; it does not start a static server, inject credentials, or start world services. Keep the demo or another application server running at `clientOrigin` first.

`view` prints a fresh snapshot. `fill`, `select`, `click`, and `submit` operate visible controls and print the resulting snapshot. `submit` uses the form's actual submit path and browser validation. `back` uses browser history. `reload` reloads the page. `close` ends that account's worker and browser.

Use refs from the latest snapshot. Single operations replace the prior ref set. Batch accepts 1–32 `{command,ref,value?}` steps (`value` is required only for `fill`/`select`), applies them sequentially against the starting handles, settles after each, and returns one fresh final snapshot. If a step fails, later steps are skipped and the error identifies the failing step and possible partial execution. Hidden, detached, disabled, wrong-kind, or stale controls fail rather than resolving elsewhere. Refs are compact worker/generation/ordinal tokens, never DOM identifiers.

```sh
node scripts/browser.mjs player open
node scripts/browser.mjs player view
```

### Saving snapshots

For longer sessions, retain full snapshots under the account's private runtime directory. Redirect to a temporary file and move it into place only on success, leaving stderr visible:

```sh
ROLE_DIR='<config-root>/runtime/<runId>/<account>'
node scripts/browser.mjs player view > "$ROLE_DIR/browser.snapshot.tmp" && mv "$ROLE_DIR/browser.snapshot.tmp" "$ROLE_DIR/browser.snapshot.txt"
sed -n '/Accounts/,+24p' "$ROLE_DIR/browser.snapshot.txt"
```

Save mutation output as well, because it contains the fresh snapshot and refs. Prior refs are invalid after any successful mutation and after a failed batch, even if output was redirected or trimmed.

Visible input/select values appear in snapshots. Password inputs and controls whose labels or names indicate password, secret, token, or credential are shown as `[REDACTED]`; known values entered into sensitive fields are masked if echoed elsewhere. Do not pass credentials to `fill`: shell arguments may be visible to local process inspection. The DOM worker does not perform account login; use the page's visible Accounts form when testing browser sign-in.

## Boundaries

The application commands exercise the same account login, client session, page reads, action submission, and retained action records as the client application. Gameplay assertions through the harness use `createApplicationTransport`, not direct world POSTs, manual native-token injection, or private service mutation. The browser client keeps its own per-account client sessions in `localStorage`, retaining sign-in after closing and reopening the browser. Explicit logout revokes the requesting token and removes that account's local session. DOM checks verify rendering and visible controls separately.

The older `run/game.mjs` and `run/manuals/player.md` are historical API provenance for supervisor/archive tooling, not an active browser gameplay path. Board and observer archive commands are separate tools.
