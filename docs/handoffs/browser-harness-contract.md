# Browser-backed text harness contract

## Goal and authorization

The user wants the run CLI to be a harness over the actual browser client: clean rendered HTML into Markdown-like text and offer textual navigation/form operations. The user explicitly authorized headless browser execution and focused UI checks for this work, overriding the standing no-UI-testing rule for this scope. Context7 remains waived.

The current roleplay world remains paused at tick 4 after three encounter groups. Do not resume roles, advance ticks, restart services or alter live game state during implementation checks. Use isolated test worlds. Preserve earlier failed departure history and role memories.

## Ownership and boundaries

- Browser application owns authentication, selected Player/vessel, action discovery, HTTP calls and gameplay semantics. Both human and harness use the same HTML/JS bundle.
- Harness owns browser lifecycle, isolated contexts, DOM-to-text rendering and visible control interactions. It must not construct gameplay HTTP requests, invoke page application functions, execute action payloads directly, or render backend responses outside the DOM.
- Run adapter owns mapping a role to its browser session and existing credentials. Bootstrap credentials through actual visible session fields, never a hidden gameplay interface. One isolated context/session per role; preserve page memory between CLI calls. Do not print or log credential values or password fields.
- Board and observer archive tooling are separate from the gameplay browser interface. Preserve historical API CLI for provenance, but participant gameplay guidance must use the browser harness.

## Browser UI checkpoint

Add a visible session form `#session-form` with named fields `role` (select: `player`, `policy-admin`, `simulation-admin`, `authority-admin`), `player` (URI), `vessel` (URI), and `credential` (password). Submit applies the session; a visible `#session-status` reports role/Player/vessel without secrets. The password field clears after applying; credentials remain only in page memory. Preserve existing demo controls as applicable; no secret persistence or config credentials.

Players use native credentials for their selected Registry vessel and derive Territory diplomatic tokens with shared auth. Native/diplomatic calls never use administrator substitution. Refresh and manual Registry controls must select the vessel; simulation visit selection must match that vessel. Administrator roles only receive their own service credential. Disable or hide controls unavailable to the selected role, keeping server authorization authoritative.

Provide visible state/action discovery panels for Registry, A, B with real refresh buttons and action buttons. Display current state, effects, unavailable reasons and request details as text. Each action button executes its advertised request in browser code using the appropriate credential scope and explicit configured-origin checks. No auto-execution or itinerary. Include visible pending/error status and accessible names/labels. Preserve resource browsing, ASCII rendering, proof comparison and experimental manual forms.

Public browser config uses existing `{origins:{authority,policy,simulation},actors?:...}` shape. It must contain no credentials. Allow the run to serve the same client with its actual origins, without starting another set of game servers.

## Generic harness API checkpoint

Implement `apps/browser-harness/src/index.ts` with `createBrowserSession({url,allowedOrigins,headless?})` returning an isolated Chromium session. Pin Playwright and install Chromium once. Expose methods:

- `view(): Promise<TextView>`
- `fill(ref: string, value: string): Promise<TextView>`
- `select(ref: string, value: string): Promise<TextView>`
- `click(ref: string): Promise<TextView>`
- `submit(ref: string): Promise<TextView>`
- `back(): Promise<TextView>`
- `reload(): Promise<TextView>`
- `close(): Promise<void>`

`TextView` has `{url:string, markdown:string}`. Markdown includes headings, visible prose, code/pre preserving whitespace, links, labelled inputs/select options/buttons, disabled/checked states and opaque interaction refs. References identify elements of the latest view; stale refs fail rather than selecting another element. Exclude hidden content/scripts/styles, mask passwords and known injected secrets, and do not expose hidden app state. Ref operations must require visible enabled controls of the appropriate kind. Submit uses real form submission/validation/event handlers. Wait boundedly for browser activity to settle; no arbitrary sleep-based gameplay progression. Restrict navigation and requests to configured client/service origins. No APIRequestContext/backend bypass.

Expose the browser client's real async operation status using DOM attributes/accessible status if needed; no test-only hook. Human users should benefit from the same pending/error state. Do not treat networkidle alone as proof of business completion.

## Run adapter checkpoint (after API is available)

Provide `node run/browser.mjs <role> open|view|fill <ref> <text>|select <ref> <value>|click <ref>|submit <ref>|back|reload|close`. First open launches a persistent role-local process/socket with mode 0600 and bootstraps only that role through session-form. Subsequent commands use its existing browser state. Credential args never reach process argv/output/audit; the adapter reads the existing own-role credential file internally. Explicitly configure all five Players and three distinct administrator roles.

Extract/reuse the demo's static client server instead of copying the HTML or starting another Authority. Serve the same bundle against paused-run origins when deployment is separately authorized. Shutdown closes browser contexts/processes and the standalone client server. CLI text is derived from the live page; API syntax is no longer the Player's gameplay interface.

## Verification

Use bounded fresh General agents with separate ownership. Supervisor reviews semantics; agents run build, typecheck, ESLint, focused browser checks and the integrated gate. Meaningful checks: actual rendered client login for nondefault Player/vessel, visible discovery and unavailable reasons, A production through DOM forms/buttons, Registry entry/departure targeting current berth, role/session isolation, stale/disabled refs, masked secrets, navigation and cleanup. Do not infer completed business events from a click or HTTP delivery acknowledgement.

## Checkbox and radio click checkpoint

- `BrowserSession.click` accepts visible enabled button/link references as before, and additionally accepts only `input[type=checkbox]` and `input[type=radio]`. It dispatches through the Playwright element click, retaining browser state changes and page event handlers. Other input types remain rejected; ref freshness and visibility/enabled checks are unchanged.
- The generic harness fixture verifies a checked checkbox toggles to unchecked and back to checked using each returned view's current reference.
- Verification passed sequentially: `npm run build`; `node --test tests/browser-harness.test.ts` (1 passed); `npm run typecheck:tests`; `npx eslint apps/browser-harness/src/index.ts tests/browser-harness.test.ts`.
