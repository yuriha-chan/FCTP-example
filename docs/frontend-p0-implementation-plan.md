# P0 frontend implementation plan

## Delivery goal

A player and an administrator can run the game through the stateful client application. The browser renders page data and submits actions; the harness performs the same operations through the same application endpoints.

Deliver a single replacement frontend. Remove the manual-session UI, browser-held credentials, direct-world frontend adapters, and compatibility-only code/tests rather than maintaining two interfaces. Required gameplay capabilities are implemented in the application workflows below; pending tasks are not satisfied by retaining retired screens.

Requirements:

- [Frontend requirements and priorities](frontend-requirements.md): individual P0 requirements define delivery scope.
- [Frontend technical requirements](frontend-technical-requirements.md): architecture, retained model, and page/action APIs.

Each task below identifies its dependencies, code ownership, implementation work, and completion evidence. Complete workflows across sections rather than implementing entire navigation sections in order.

## Implementation structure

| Location | Ownership |
| --- | --- |
| `packages/identity/src/` | Handle parsing, server normalization, WebFinger and Actor resolution. |
| `packages/auth/src/` | Native-login contracts and existing diplomatic derivation/digest primitives. |
| `packages/client-sdk/src/` | World-server calls and shared client-application request/response types. |
| `apps/test-authority/src/` | Home account/password login, Registry, authoring, and account availability management. |
| `apps/territory-policy/src/`, `apps/territory-sim/src/` | Territory operations, movement outcomes, administrative controls and decisions. |
| `apps/client-server/src/` | Application services, durable client state, adapters, page models, and API routing. Add this TypeScript project. |
| `apps/demo/src/client-server.ts` | HTTP/static entry point; mount the client application API before the static GET/HEAD handler. |
| `apps/demo/src/launcher.ts` | Start the application with a persistent client store and configured world discovery seeds. |
| `apps/client/src/`, `apps/client/index.html`, `apps/client/styles.css` | Browser rendering, navigation, and forms. |
| `scripts/browser.mjs`, `scripts/browser-worker.mjs`, `scripts/browser-transport.mjs`, `apps/browser-harness/` | Harness access to application page/action APIs and command presentation. |
| `tests/` | Contract, persistence, adapter, server integration, and gameplay verification. |

Keep generic world operations in the SDK and Territory-specific field translation in backend adapters. The backend owns persistence and account context. The browser and harness consume the same contracts.

## Task order

```text
01 Contracts and operation inventory
 ├── 02 Home login and account availability ── 04 SDK authentication
 ├── 03 Durable application core ──────────── 05 Accounts and connections
 └────────────────────────────────────────── 06 Page/action infrastructure
                                               ├── 07 Places and routes
                                               ├── 08 Logistics and production
                                               ├── 09 Authoring and reading
                                               └── 10 Administration
07 + 08 + 10 ── 11 Journey execution
05–11 ──────── 12 Harness integration and full-game acceptance
```

Build the corresponding browser page/form as each backend slice becomes usable. Task 12 completes integration; it is not the first time a workflow reaches the frontend or harness.

## 01 — Define contracts and map executable world operations

**Depends on:** none.

**Files:** `packages/identity/src/index.ts`, `packages/auth/src/`, `packages/client-sdk/src/application.ts` (add), relevant protocol and application route types.

1. Add handle parsing that separates the local name from `domain:port`, retaining the distinction between account and authority handles.
2. Define server, authority, account, login-state, sourced observation, page response, action descriptor, and action-record types. Keep native-token-bearing internal records separate from public account responses.
3. Define `accountId` as an explicit parameter for account-dependent reads and actions. Use application record IDs in API paths and retain exact world URIs in those records.
4. Specify Home login input `{ handle, password }` and its account/native-token response, including unavailable-account and rejected-login results. Use proposed `POST /local/home/login` for the Home endpoint; this differs from application `POST /api/accounts/login`.
5. Inventory each supported action's world endpoint, request fields, authorization, result, and completion evidence. Start with existing `/local/actions` discovery and the route handlers named in tasks 07–11.
6. Map route legs to Territory execution: boundary-to-port entry, port-to-boundary departure, and advertised port-to-port routes. For every leg in the acceptance fixture, record the responsible Territory file/handler, HTTP method/path and input fields, resulting request/event, and completion evidence. Assign every missing handler to task 11.
7. Inventory approval/rejection operations separately from automatic admission policies. Manual review in task 10 applies to incoming `EntryRequest` messages; map approval to the existing acceptance/berthing lifecycle and rejection to `EntryRejected`.

**Completion:** shared types compile; contract tests cover handles including explicit ports, account separation, page observation states, and action submission versus completion. The operation inventory identifies an execution path and evidence for each P0 action, including missing handlers to implement. Put the inventory in `docs/frontend-p0-operation-contracts.md` as part of this task.

## 02 — Implement Home password login and account availability

**Depends on:** 01.

**Files:** `apps/test-authority/src/home.ts`, `bootstrap.ts`, `app.ts`; `packages/auth/src/`; authority fixtures and tests.

1. Extend durable Home account records with password hashes and availability. Support configured player and administrator accounts rather than assuming every login is a Player Actor.
2. Add password provisioning to account/bootstrap fixtures. Use a salted password-hash representation and server-side verification; store the hash rather than the password.
3. Implement `POST /local/home/login` using the task-01 contract: resolve the local account, verify its password and availability, and return its identity and native token.
4. Reuse existing native-token issuance, rotation, and digest distribution. Define successful repeat-login behavior so signing in does not accidentally invalidate other retained sessions or leave resource-server digests inconsistent.
5. Add home-authority-authenticated account listing and availability changes, with explicit account targets. Account availability, client logout, and server connectivity remain separate states.
6. Retain existing administrator provisioning interfaces for fixture setup and existing callers.

**Completion:** tests prove successful login, wrong password, unavailable account, two accounts with the same local name at different Homes, repeat login, restart persistence, and diplomatic access using the resulting native token. Availability changes are exercised through the Home authority interface.

**Existing test seams:** `tests/authority-app.test.ts`; add focused Home login tests.

## 03 — Add the durable client application core

**Depends on:** 01.

**Files:** add `apps/client-server/src/{app,store,model}.ts` and its TypeScript project; update root references, `apps/demo/tsconfig.json`, `apps/demo/src/client-server.ts`, and `launcher.ts`.

1. Store application state in `JsonSnapshotStore.domain.client` using a client-owned schema and accessor. Reuse its serialized transactions and atomic snapshot writes.
2. Persist servers, authorities, accounts, login state, observations, drafts, route plans, action records, and followed requests/jobs.
3. Pass `client.store.json` under the demo `dataDir` to the client application. Keep seed server configuration separate from discovered server records.
4. Add `/api/*` dispatch before the static-only method check in `startClientServer`. Continue serving the browser assets through that HTTP server.
5. Add `apps/client-server/tsconfig.json` to root `tsconfig.json` project references and to the demo project's references. Declare its SDK/server-base dependencies and update frontend/test references for shared contracts where needed.
6. Expose `createClientApplication` from `apps/client-server/src/app.ts`, accepting a store path and injectable HTTP dependencies. Mount it through `startClientServer`; fixtures start that same HTTP entry point with their own store and discovery seeds. Wire application startup and close through the demo launcher.

**Completion:** application state survives server recreation using the same store; concurrent account writes retain both results; API and static requests work on the same origin; startup/shutdown integrate with `startDemo`.

**Existing test seams:** `tests/client-server.test.ts`, `tests/demo-launcher.test.ts`.

## 04 — Extend SDK authentication and discovery

**Depends on:** 01, 02.

**Files:** `packages/client-sdk/src/`, `packages/identity/src/`; extract reusable helpers from `apps/client/src/client.ts`.

1. Add typed Home login and account/authority resolution calls.
2. Reuse WebFinger/Actor resolution and expose resolved handles, Actor IDs, home relationships, and resource-server audiences.
3. Add reusable authenticated world requests parameterized by account credentials and target Actor. Derive diplomatic tokens using the existing auth package.
4. Move reusable public-first JSON/text retrieval, `resourceAudience`, and collection reading out of browser-only code.
5. Preserve public-first behavior: retry only on 401/403 with a known audience; report other failures directly.
6. Keep stored accounts and tokens in the backend; SDK calls receive their explicit context.
7. Remove browser-only request wrappers and reference-reader compatibility branches after extracting reusable protocol operations. Do not preserve the retired frontend's calling conventions as an SDK requirement.

**Completion:** tests use login-issued tokens against distinct resource Actors and prove public reads, authenticated fallback, missing audience errors, and account/audience separation. Home digest delivery and client derivation are both exercised.

## 05 — Deliver account and connection APIs and UI

**Depends on:** 02, 03, 04.

**Endpoints:** `GET /api/accounts`, `POST /api/accounts/login`, `POST /api/accounts/:accountId/logout`, `GET /api/servers`, `POST /api/servers`.

**Files:** backend account/discovery services and routes; frontend account/connection controls; demo/test account setup.

1. Accept handle/password login, call Home through the SDK, and persist the returned native token under that account.
2. Return identity and status to frontend/harness callers. Keep native tokens in backend records.
3. Discover and retain servers, authority Actors, roles, and relationships. Discover from supplied server/handle and advertised links rather than a fixed A/B authority list.
4. Render login, account selection/logout, known-server addition, and inspectable authority details.
5. Keep selected account in interface context and send its ID with each operation.
6. Define a backend-only administrator binding: account ID, permitted authority Actor IDs, and the configured credential source for each target. Registry, policy, and simulation controls currently use authority-specific administrator authorization, separate from Home-issued native tokens. Adapters resolve the appropriate configured credential through this binding and reuse server authorization checks. Account/page responses and browser action requests carry account and target IDs, not administrator credentials. Include the bindings in fixture/config contracts.

**Completion:** two callers can act as different accounts without overwriting one another. Logout retains known identities and places. A failed server connection does not log out the account. A server can be discovered and read publicly before login.

## 06 — Implement page observations and action lifecycle

**Depends on:** 03, 04, 05.

**Endpoints:** page/action envelopes, `GET /api/activity`, `GET /api/activity/:actionId`, and explicit refresh actions.

**Files:** backend observation/action services; frontend shared page, status, and result components.

1. Represent each independently retrieved section with source, retrieval time, and retrieval state: available, empty, not retrieved, stale, or unavailable.
2. Show readable names/handles with exact identities available in details. Retain competing observations rather than synthesizing one location or cargo total.
3. Bound independent source requests so an unavailable server does not block unrelated page sections or workflows.
4. Record account, target, submitted values, submission status, completion status, result references, and subsequent evidence for each action.
5. Refresh prerequisites before submission. Distinguish a failed submission from successful submission followed by failed read-back.
6. Persist pending requests/jobs and let explicit refresh reconcile them after a client restart. An uncertain interrupted submission remains unverified until reconciled.
7. Expose current pending actions and individual results through Activity. Render action inputs, target, expected result kind, pending/completed state, and errors consistently across pages.

**Completion:** integration tests cover rejected, pending, completed, and unverified actions; a read-back failure does not erase a successful submission; source failures remain local; restart retains pending work. The Activity UI supports retrieving pending requests and their decisions without requiring the P1 consolidated history interface.

## 07 — Deliver places, capabilities, and route selection

**Depends on:** 05, 06.

**Endpoints:** place list/detail/refresh; route creation/detail under `/api/explore`.

**Files:** backend discovery/topology services; Territory adapters; frontend Explore pages.

1. Read advertised ports, routes, boundaries, areas, maps, and listings from Actor resources. Existing entry points include `territoryResources`, `readCollection`, and Territory resource collections.
2. Build the geographical graph from explicit `Route.from` and `Route.to` resource references. Resolve linked places outward and retain provenance and direction where established.
3. Present connected places and onward connections, with current vessel position observations. Display unknown connectivity separately from a known inaccessible route.
4. Show capabilities, inputs, outputs, permissions, and known blockers on each place detail page using its actual supported operations.
5. Let the user choose a connected destination, inspect route legs, and save a route plan. Carry the same place/route IDs into Logistics & Production.
6. Open authority profiles, linked publications, authors, and referenced resources through shared identity/resource views.
7. Use adapter selection by discovered capability/service shape, not by fixed server port or the labels A/B. Add another server instance to the fixture to prove this.

**Completion:** a user discovers onward places through route references, inspects their capabilities, selects a destination, and reaches its operational page with the selection intact. Tests cover unresolved endpoints, conflicting location observations, a known access restriction, and an additional server without a dedicated frontend panel.

## 08 — Deliver vessel, cargo, production, and jobs

**Depends on:** 05, 06; place navigation integrates with 07.

**Endpoints:** vessel detail, entry request, departure, load/unload; production list/operation/execute/job/refresh. Add explicit vessel refresh and Registry adoption actions to the API contracts as required by existing operations.

**Files:** backend `adapters/registry.ts`, `adapters/policy.ts`, `adapters/simulation.ts`; frontend Logistics & Production pages; reusable SDK calls.

1. Adapt Registry `/local/registry/state`, `/actions`, `/entry`, `/departure`, and `/adoption`.
2. Present vessel cargo, Registry location, each Territory's local visit/cargo, shared stocks, and pending requests as distinct observations.
3. Adapt policy `/local/info`, `/state`, `/actions`, `/mine`, `/manufacture`, `/transfer`, `/load`, and `/unload`.
4. Adapt simulation `/local/state`, `/actions`, `/mine`, `/manufacture`, `/load`, and `/unload`. Track returned jobs and their observed progress separately from immediate policy results.
5. Expose operation inputs, quantities, capacity, permissions, prerequisites, and output destinations before submission. Refresh and validate against the selected account/place before invoking the operation.
6. Render mining, manufacturing, cargo transfer, and job forms from the backend's typed capabilities. Repeated production references existing definitions rather than republishing them.
7. Keep job progress dependent on actual simulation state and administrator ticks; reading a page does not advance the world.

**Completion:** fixtures demonstrate mining, manufacturing, loading, unloading, repeat production, immediate results, timed jobs, insufficient inputs, and cargo/stock separation. Switching Registry adoption changes Registry observations without rewriting Territory state.

**Existing test seams:** `tests/registry.test.ts`, `tests/registry-multivessel.test.ts`, `tests/policy-actions.test.ts`, `tests/sim-actions.test.ts`, and the corresponding app tests.

## 09 — Deliver Library, authoring, publication, and reading

**Depends on:** 05, 06.

**Endpoints:** `/api/library`, draft create/read/save/publish, resource read/refresh. Full publication preview remains P1.

**Files:** backend authoring/resource services and authority adapter; frontend Library, authoring, and resource-reader views.

1. Adapt `GET /local/authoring`, `POST /local/authoring/assets`, `POST /local/authoring/varieties`, and the player's creations collection.
2. Persist drafts with readable fields and repeatable production ingredients/yields, location, tool, duration, and resource references supported by the existing authoring model.
3. List published resources and open known resources for reading and ingredient/reference selection.
4. Preserve authority-side validation, signing, and Asset-grant behavior when publishing Varieties that reference owned Assets.
5. Return the created resource identity immediately; perform read-back as a separate observation and open readable content from the result.
6. Render Asset text/media and author/source/reference links using SDK public-first retrieval. Keep authored descriptions selectable even without an executable production operation.
7. Reuse the reader in Explore and Logistics & Production.

**Completion:** publish an Asset, read it, use it in a Variety's production description, publish the Variety, and inspect the resulting resources/grants. A read-back failure remains distinct from publication failure. Drafts and resource identities survive restart.

**Existing test seams:** `tests/player-authoring.test.ts`, `tests/local-publication.test.ts`, `tests/authority-app.test.ts`.

## 10 — Deliver administrator decisions and controls

**Depends on:** 02, 05, 06.

**Endpoints:** administration page/request detail, approval/rejection, control changes; Home account-availability control from task 02.

**Files:** backend administrator adapters; relevant Territory/Registry/Home handlers; frontend administration forms.

1. Map the concrete controls: policy/admission rules, simulation facilities/tick, Registry fleet/adoption where authorized, and Home account availability.
2. Render the target authority, current values, submitted values, and result for each supported control.
3. Expose pending requests, relevant policy/facility context, decisions, and resulting events.
4. Add manual review for incoming `EntryRequest` messages in both Territory implementations. Keep current automatic admission as the default; select manual review explicitly through admission configuration. Persist the original request, sender, verification context needed by the existing acceptance path, and decision state.
5. Add proposed authority-authenticated `GET /local/admin/entry-requests` and `POST /local/admin/entry-requests/:requestId/approve` or `/reject` handlers. Approval resumes the existing acceptance path; rejection emits the existing `EntryRejected` with the original request ID and reason. Preserve each Territory's prerequisite checks and timing. A repeated decision returns its existing result rather than creating another visit.
6. Return a decision record linked to the original request and resulting events. Approval is not immediate berthing: the client tracks the accepted work until `BerthingEvent` establishes the visit. `EntryRejected` establishes rejection. Retain those references in the administrator result and requesting player's action record.

**Completion:** an administrator inspects and approves one pending request, rejects another with an observable reason, changes supported policy/facility values, advances a simulation job, and changes account availability. Unauthorized accounts cannot execute these controls. Automatic admission continues working in existing scenarios.

**Existing test seams:** policy/simulation app and Territory tests, Registry tests; add manual-decision integration tests.

## 11 — Execute selected routes through world operations

**Depends on:** 07, 08, 10; operation mapping from 01.

**Endpoints:** `POST /api/logistics/vessels/:vesselId/traverse`, route/journey status through persisted action records and vessel pages.

**Files:** backend journey service; Registry/Territory adapters; Territory movement handlers identified in 01; route fixtures.

1. Execute a selected route as a persisted sequence of actual world operations. Use Registry entry/departure requests and Territory events for the legs they implement.
2. Wait for the relevant accepted visit, departure, or exit evidence before advancing a dependent step. Retain rejection, pending review, and unverified outcomes.
3. Pass recorded exit evidence through the next entry request using the existing Registry mechanism.
4. Complete every missing operation in task 01's leg mapping before treating that route as executable. An advertised port-to-port leg needs an actual local movement transition and observable outcome on its responsible Territory when entry/departure do not execute it. Specify the handler, request fields, and authoritative movement event/state in the operation inventory, implement it in that Territory's `app.ts`/`territory.ts`, expose it through local action discovery, and adapt it in the backend. Prove the vessel reaches the leg's destination; a successful HTTP response is insufficient.
5. Keep each Territory's authority over its own movement, time, admission, and cargo. Use boundary/port topology from explicit routes when preparing the connected fixture.
6. Persist leg progress and reconnect it to request/event evidence after restart. A journey succeeds only when its required world outcomes have been observed.
7. Render journey progress in Logistics & Production and link back to the selected route in Explore.

**Completion:** traverse a real connected route, observe departure/exit and destination acceptance, and inspect the resulting visit. Tests also cover delayed simulation movement, rejection, interrupted observation, and advertised local legs. An entry request alone is not evidence of completed traversal.

## 12 — Integrate the harness and prove a complete game

**Depends on:** 05–11.

**Files:** `scripts/browser*.mjs`, `apps/browser-harness/`, gameplay fixtures/tests, client launch documentation.

1. Add direct client-API transport for account login, page reads, described actions, and result retrieval. Retain public account names as canonical harness identities.
2. Replace gameplay's DOM/session injection with explicit application account context and password-based fixture login. Keep browser rendering checks separate from gameplay API calls.
3. Ensure CLI and worker startup discover the client application origin and use the account records produced by login. Return the same page models/action results the frontend consumes.
4. Provide isolated fixture startup with Home, Registry, both Territory implementations, connected route resources, player/admin accounts, and administrator bindings. Start `createClientApplication` through `startClientServer` with a fixture-specific store and discovery seeds pointing to those world-server origins.
5. Document startup through the existing demo launcher, the client data location, test account setup, and direct harness/API usage. Wire any required package/config changes into `npm run dev` and the existing build.

### Full-game acceptance scenario

Run this scenario through the client API, with frontend forms supporting the same steps:

1. Discover servers publicly; follow route/place references and inspect capabilities.
2. Log in as two player accounts and an administrator; keep their request contexts independent.
3. Inspect and select a route; enter the first Territory and observe the decision.
4. Mine, manufacture, and load goods; inspect local stocks and cargo observations.
5. Depart and traverse to the second Territory using actual exit evidence.
6. Unload imported goods, use supported inputs in production, and observe a timed job completed through administrator-controlled ticks.
7. Publish an Asset and a Variety with production ingredients/yields; read both and select the Asset as a reference.
8. Inspect and approve/reject manual-review requests and change a supported administrative control.
9. Restart the client application; recover accounts, drafts, selected routes, pending actions/jobs, and sourced observations.
10. Make one source unavailable and confirm another place and its workflows remain usable.

**Completion:** player/admin workflows run through application endpoints with no manual native-token injection. The browser supports the same P0 actions. Automated API gameplay proves state changes and evidence; the user verifies page usability in the browser.

## P0 coverage map

| P0 requirement group in `frontend-requirements.md` | Tasks |
| --- | --- |
| Place connections, onward exploration, vessel position, route legs, traversal, destination handoff | 07, 08, 11 |
| Place capabilities, inputs/outputs, prerequisites, shared place identities, unknown versus unreachable/permitted | 01, 06, 07 |
| Authority/publication links, work authors and references | 07, 09 |
| Vessels, cargo, local visits, entry/departure, loading/unloading, shared stocks | 08, 11 |
| Production execution, repeat use of existing definitions, jobs, remaining time, refreshed prerequisites | 06, 08, 10 |
| Action target/inputs, submission versus completion, pending results, failures and read-back distinctions | 06 and every action slice |
| Published-resource list, readable known resources, authoring fields, publication and immediate resource identity | 09 |
| Public-first resource retrieval, precise errors, authored descriptions usable as references/ingredients | 04, 09 |
| Pending requests, decisions, and current action results | 06, 08, 10 |
| Administrator request inspection, approval/rejection, policies/controls, change target and values | 02, 05, 10 |
| Sources/ages, empty/unavailable/stale states, refresh scope, conflicts, Registry/local distinctions | 06, 07, 08 |
| Public account access, player/admin credentials and authorization | 02, 04, 05, 10 |
| Additional servers without fixed panels, readable identities, evidence-based discovery, independent failures | 04, 05, 06, 07, 12 |

P1/P2 enhancements remain separately prioritized: combined Overview, cross-place search, rich consolidated history, full publication preview, repeat shortcuts, and advanced JSON editing. Required capabilities belong to the replacement application workflows; the retired frontend is not a fallback for pending work.

## Verification and task completion

For each implementation task:

1. Review its changes against the listed contracts and P0 requirements.
2. Add or extend tests for its meaningful state transitions and integration boundaries.
3. Run the relevant existing/new test files using the repository's TypeScript test runner and run `npm run typecheck` and `npm run lint` for touched code.
4. Mark the task complete only when its completion evidence is demonstrated.

At integration completion, run:

```sh
npm run typecheck
npm test
git diff --check
```

`npm test` includes build, test typechecking, ESLint, and the TypeScript/JavaScript test suite. Include application API gameplay tests in that suite. Ask the user to verify browser navigation, forms, readable results, and multi-server usability using the acceptance scenario.
