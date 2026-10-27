# Browser session UI checkpoint

## Browser session and request behavior

- `apps/client/index.html` exposes `#session-form` with named `role`, `player`, `vessel`, and password `credential` fields. Supported roles are `player`, `policy-admin`, `simulation-admin`, and `authority-admin`. Applying a session clears the password control, the previous native token and rendered stale state; the selected role credential is retained in the page's JavaScript memory only. `#session-status` reports role, Player and vessel identifiers without credential values.
- Player sessions use the entered native token as the Registry credential and derive Territory A/B diplomatic tokens with `deriveDiplomaticToken`. Registry state/actions and Registry mutation requests include the selected vessel. Territory actions and refresh use the appropriate Territory diplomatic token.
- Administrator sessions hold only the selected service credential and expose that service's administrative controls. Policy and simulation administration uses their respective credentials; authority token issuance and Home controls use authority administration credentials. Session-scoped forms/buttons use `data-roles` and are hidden outside permitted roles.
- The client-local discovery view types are `BrowserLocalAction` and `BrowserLocalActionDiscovery` in `apps/client/src/client.ts`; they structurally describe the local API and do not import server-base. `GET /local/registry/actions?vessel=<URI>` uses the selected Player native token. `GET /local/actions?vessel=<URI>` at A/B uses the selected Player's Territory diplomatic token. Discovery action request URLs must have an origin in configured `{origins:{authority,policy,simulation}}`.
- Discovery panels render observed state, notes, advertised request details, effects, unavailable reasons, and real action buttons. Clicking an available button executes that request in the browser with the scope-appropriate token; unavailable actions are disabled. B refresh chooses only a visit whose vessel and possessor match the selected session.
- `#operation-status[role=status][aria-live=polite][data-state]` exposes `idle`, `busy`, and `error` states and reports completion/errors. While an operation is pending, buttons with `data-action` are disabled. Errors are also rendered in the operation's output panel; handlers do not leave rejected promises unobserved.

## Changed files

- `apps/client/index.html`: session form, discovery panels, role scoping and updated credential guidance.
- `apps/client/styles.css`: hidden-role and disabled/panel presentation.
- `apps/client/src/client.ts`: browser-local structural discovery types and configured-origin validation helper.
- `apps/client/src/main.ts`: in-memory session handling, scoped credentials, Player-selected Registry requests, role-aware Territory refresh, action discovery/execution, and visible operation status.
- `docs/handoffs/browser-session.md`: this checkpoint report.

## Verification and boundary

- `npx tsc -p apps/client/tsconfig.json --pretty false` — passed; browser client TypeScript sources included.
- `npx eslint apps/client/src/main.ts apps/client/src/client.ts` — passed; the two changed TypeScript sources included.
- No DOM/UI/live-service test was run, and no test helper was added. Existing demo resource browsing, ASCII map rendering, proof comparison, token/resource controls, and manual Territory forms remain in the shared client.
- No `server-base` runtime import was introduced. The discovery shape is a browser-local view interface.

## Generic harness checkpoint contract

The shared bundle offers `#session-form` submit as the visible session bootstrap and `#session-status` as secret-free session confirmation. Every browser operation updates `#operation-status` with `data-state="busy"` before awaiting, then `idle` on success or `error` on failure; the element is a live `role="status"`. Discovery and action execution are actual DOM controls and requests, with no application test hook. A generic harness can inspect these elements and use regular form submit/click operations.

## Follow-up integration point

The action discovery routes and structural payloads were consumed from the in-progress Territory and authority changes present in the workspace at this checkpoint. The browser client's Registry Player route expects the local Registry API to accept Player-native credentials and a `vessel` query/body field. Confirm this checkpoint against the integrated deployment configuration; no services were started here.

## Bounded semantic repair checkpoint

- Discovery execution chooses its credential audience from the configured request target origin: Authority receives the selected Player's native token; configured A/B targets receive a diplomatic token derived for that Territory. `configuredOrigin` runs before token selection and request execution, so an unconfigured/foreign target is rejected. The returned discovery `kind` and `actor` do not select token audience.
- Task handling snapshots the disabled state of all button/input/select/textarea controls, disables them while pending, and restores their original states. Discovery controls retain unavailable state after completion; dynamically rendered resource controls respect busy state. `document.documentElement.dataset.clientBusy` is true during startup config loading and each task, and false in task `finally`.
- Destination defaults now come from `setupDestinationFields`; the initial configuration task invokes it directly, while the select change handler wraps it in a task. It no longer dispatches a nested change event.
- Applying a session clears private state/result/evidence/discovery panels and resource-browser contents while retaining public A/B `policyInfo` and `simulationInfo`. The existing password/native-token controls are cleared. Resource browsing uses the current Player credential when applicable and permits anonymous retrieval for public resources.
- B refresh matches accepted, non-exited visits by the exact stored/request vessel URI and possessor against the selected session, choosing the latest matching visit in state order. Player session application also selects its vessel in the legacy A operation form.
- Changed files for this repair: `apps/client/src/main.ts`, `docs/handoffs/browser-session.md`. No exported API changed.
- `npx tsc -p apps/client/tsconfig.json --pretty false` — passed; browser client TypeScript sources included.
- `npx eslint apps/client/src/main.ts apps/client/src/client.ts` — passed; both client TypeScript sources included.
- No UI test or live service operation was run.
