# Frontend replacement implementation steps

Governing design: [frontend replacement plan](frontend-replacement-plan.md), [frontend requirements](frontend-requirements.md), [technical requirements](frontend-technical-requirements.md), and [operation contracts](frontend-p0-operation-contracts.md).

## Execution rules

- Setup is not a feature and does not require manufactured RED tests.
- Each numbered implementation step below has one RED–GREEN–REFACTOR iteration covering its coherent behavior, not a separate cycle for each assertion.
- The User authorized parallel RED/GREEN delegations for independent steps. Dependencies describe integration order: components may proceed against a Lead-defined interface before shell integration when files and responsibilities do not overlap. Keep semantic RED audits and Lead REFACTOR per step; batch the full regression gate across integrated steps rather than running it after every step.
- Before RED, the Lead supplies a bounded brief: public interface, owned files, inputs/outcomes, meaningful boundary/error cases, test command, and permitted skeletons.
- A fresh Senior Programmer receives the shared delegation note, iteration brief, and RED.md as newline-separated attachments. The Lead semantically audits observed behavioral failures and corrects scoped test problems directly.
- A fresh coding agent receives the same shared note and brief with GREEN.md. GREEN changes application code only. The Lead performs REFACTOR and reruns affected tests, documenting reasons even when no structural change is needed.
- Do not confuse tool/import/setup failure with behavioral RED. Stop affected work on unresolved dependency behavior or consequential contract questions.
- Backend application state, authentication, actions, observations, and world semantics remain authoritative. Browser state owns interaction state, not another persisted world model.

## Setup — outside TDD

1. Resolve and pin the intended binduct source; inspect its actual API and React integration guidance. Verify the other approved dependency versions and engine compatibility.
2. Install React, React DOM, binduct, React Aria Components, Vite, and required TypeScript types using npm. Keep the existing test runner unless evidence establishes a need to change it.
3. Configure JSX typing, CSS Module typing, TSX lint coverage, and an isolated Vite build target. Keep the existing served frontend operational until replacement acceptance; do not expose two supported product workflows.
4. Establish disposable browser fixtures for React lifecycle and accessibility checks using the existing Playwright infrastructure. No demo/Harbor launch or user-state reuse.

Setup acceptance: dependency resolution, typechecking, a minimal Vite build, and the existing baseline remain valid. Wiring the production static host and Docker artifact is step 19, not an incidental setup change.

## Interaction sketches

- **First visit:** sign-in form → handle/password submission → account identified by full handle → selected topic. Add account opens the same form without discarding another session. Rejected saved sessions prompt sign-in for that account, not silent access to another account.
- **Shell:** persistent account switcher + topic tabs → one visible topic panel. Switching tabs preserves working drafts. Switching account closes private overlays and invalidates private pending renders.
- **Authoring:** choose Asset or Variety → dedicated editor → field-local Choose button → typed picker → inspect candidate in that context → select → only the originating field changes. Cancel returns focus without changing the draft.
- **Pickers:** local filtering over explicitly retained candidate sources, showing source/freshness and empty/stale/failure states. Refresh is explicit world observation. Asset and Variety use Library; Port and Area use Explore, supplemented only by evidenced workflow context.
- **Travel:** select vessel → inspect position/visit/cargo → Explore places → choose destination and explicit directed route → Logistics handoff → submit → follow evidence per leg. Connectivity, permission, and missing information remain separate.
- **Production:** vessel and authority → observed operations and typed inputs → submit → result/job → explicit refresh. Personal cargo, Territory stock, and destination are separately labeled.
- **Activity/admin:** retained outcome list → detail/evidence/context; authority selection → observed supported controls → mutation → independent verification. Approval is not berthing.

## Granular steps

| Step | Bounded implementation and public behavior | RED acceptance focus | Dependencies |
|---|---|---|---|
| 1 | Verified binduct-to-React lifecycle seam for shared interaction state; define its smallest API only after inspecting binduct | Observable updates, replacement and arrays; subscription cleanup; StrictMode mount/unmount/remount; no cross-instance state leakage | Setup |
| 2 | Session-aware frontend API boundary using existing application endpoints and localStorage contract | Handle/password login, persisted concurrent sessions, exact-account Bearer selection, selective logout, rejected session and late-401 safety; no native token exposure | 1 |
| 3 | Accessible account shell and topic navigation using React Aria and CSS Modules/tokens | First sign-in, add/switch same-name accounts on different hosts, logout, keyboard tab navigation/focus, one active panel; drafts survive navigation and private renders cannot cross accounts | 2 |
| 4 | Connections/discovery workflow | Discover by supported handle/origin; retained GET versus explicit observation; published identities, independent source failures, useful errors | 3 |
| 5 | Contextual resource reader/dialog | Open from caller context, readable structured/text/media results, source/freshness/error, public-first/account isolation, stale response suppression, close/focus return | 3 |
| 6 | Asset and Variety picker interaction using retained Library candidates | Type-specific filter, names/provenance, inspect without selecting, exact-field insertion, cancel/focus, empty/stale/error and obsolete-result handling | 5 |
| 7 | Dedicated Asset editor and retained Library workflow | Create/save/reopen incomplete drafts, navigation preservation, ownership/account isolation, contextual reference selection, extension-preserving edits | 6 |
| 8 | Dedicated Variety editor with structured descriptive Production | Multiple entries/ingredients/Areas/yields; exact tool/ingredient selection; preserve unrelated extensions and incomplete drafts; no executable-recipe semantics | 6, 7 |
| 9 | Publication and readback presentation for both editors | Persist accepted identity/grant references; readback explicit and separate; failed readback stays unverified without republishing; Activity linkage | 7, 8 |
| 10 | Explore geography and typed Port/Area pickers | Retained places/Areas/routes, source freshness, explicit directed edges, known unreachable versus unknown and permission; select/inspect exact field; nearby suggestions require known position | 4, 5, 6 |
| 11 | Vessel selection and scoped logistics summary | Explicit owned vessel, Registry cargo/location/adoption/pending versus Territory visit/stock; unknown versus empty; account/vessel late-response isolation; refresh does not tick | 3, 10 |
| 12 | Route planning and Explore→Logistics handoff | Persist account-owned directed plans and carry vessel/destination/legs without manual IDs; no reverse edges or permission inference; invalid/stale plan feedback | 10, 11 |
| 13 | Entry, departure, and journey controls | Manual review versus actual berth, signed exit, per-leg completion, uncertain send/readback, refresh without replay or time advancement; preserve authoritative action evidence | 12 |
| 14 | Immediate production and cargo controls | Typed quantities/recipe/Variety/direction, observed blockers/outputs, authority-qualified choices, actual mine/manufacture/transfer/load effects and separate cargo/stock | 11, 10 |
| 15 | Timed operations and job tracking | Authority-qualified jobs, retained pending state across restart, explicit status refresh, failed source not false completion; no implicit simulation tick | 14 |
| 16 | Activity list/detail and contextual recovery | Owned actions only; acknowledgment versus completion, pending/rejected/unverified/stale states, exact evidence in disclosure, links to resource/job/vessel/journey | 5, 9, 13, 15 |
| 17 | Authority-scoped administration | Only established exact bindings/Home governorship; observed settings and supported controls; entry decision versus berth; no inferred privilege or remote-root delegation change | 3, 16 |
| 18 | Home availability controls | Governor-scoped account list, other-account availability changes and observed result; self-disable rejection, no invented universal recovery policy | 17 |
| 19 | Vite production artifact integration | Application API remains first, static HTML/JS/CSS delivery and content types, demo/standalone serving and Docker copy paths agree; deep links only if deliberately introduced | 3–18 |
| 20 | Scenario/world-effect acceptance through replacement interface | End-to-end account, travel, goods/jobs, authoring/readback and administration scenarios; keyboard/focus, restart, stopped sources and isolation; User usability remains a separate gate | 19 |

For steps that change existing behavior, adapt the relevant existing tests rather than duplicating their ownership. Add separate tests only for genuinely distinct boundaries such as the binduct lifecycle seam. Related assertions belong in the same step's RED suite.

## Existing application support and API change gate

| Capability | Existing endpoints and retained sources |
|---|---|
| Sessions/accounts | `POST /api/accounts/login`, authenticated `GET /api/accounts`, `POST /api/accounts/:id/logout`; caller sessions already persist independently of Home-native credentials |
| Discovery | `GET/POST /api/servers`; published identities, not URL-tail identities |
| Geography | `GET /api/explore/places`, place detail, explicit refresh endpoints, saved `/api/explore/routes`; advertised Ports, Areas and directed Routes |
| Reader | `GET /api/resources/:id`, `POST /api/resources/:id/refresh`; retained account-scoped/public observations |
| Authoring candidates/drafts | `/api/library`, `/api/library/refresh`, `/api/drafts`, draft read/save/publish; typed entries and distinct publication actions |
| Logistics | `/api/logistics/vessels/:id`, refresh/entry/departure/adoption/traverse; Registry and Territory observations, owned actions/journeys |
| Operations/jobs | `/api/production`, refresh, operation read/execute, job read/refresh; qualified IDs and source observations |
| Outcomes/admin | `/api/activity`, action read/refresh; `/api/administration`, refresh/controls and entry approval/rejection |

Research establishes retained candidate sources, not a need for a general search endpoint. First implement filtering over the appropriate retained data, with explicit observation controls and honest scope. Before any API addition, document the exact field interaction, missing data, smallest delta, and authentication/freshness/retained-read implications. Broader remote search is not implied by type-ahead.

Detailed public interfaces and tests for each step are materialized immediately before that iteration, using current source evidence. Do not guess experimental dependency signatures or pre-build future abstractions.

## Replacement cleanup and verification

- After scenario equivalence, remove superseded controllers, markup, global reference routing and obsolete interface-specific tests. Removal is refactoring, not a manufactured RED asserting absence. Preserve domain/SDK/application tests and reusable contracts.
- Run affected tests after Lead refactoring and the full repository gate at integration milestones, with `pipefail` and a 300000ms timeout for the full filtered test command.
- Docker image/Compose verification still requires a Docker-equipped environment; do not present source/build checks as image verification.
- Preserve user-owned root files, historical stores, run artifacts and keys. No world launch or commit/push without authorization.

## Execution status and blockers

The User supplied `https://github.com/yuriha-chan/binduct` after confirming it is not published on npm. The application pins User-published commit `7260123d45ff0b4afd8a1929897f8e5ad2c1b0e0`. React, React DOM and React Aria Components installed successfully.

- User authorized binduct source repair and the esbuild upgrade. esbuild 0.28.2, Vite 8.3.5 and React types are installed. The isolated apps/frontend bootstrap builds to dist/frontend, with TSX/CSS Module checking. It is not served as a product interface; existing serving and Docker paths remain unchanged.
- A separate checkout at `/tmp/opencode/binduct` contains the syntax repair, advertised update export and disposable subscription implementation. One library RED–GREEN–REFACTOR cycle verifies 11 scoped tests and public types. The full library suite has 27 passing tests and one preserved baseline typed-array failure. Library verification and application React lifecycle verification are separate boundaries.
- The existing typed-array test constructs Uint8Array but expects pop/resizing; it actually fails earlier on length. The User chose to leave typed-array behavior and its test unchanged. No test was skipped, removed or changed to hide that baseline failure; it does not block ordinary-array or React lifecycle verification.
- The User published the repair. The pinned remote matches the local runtime source, declarations and tests, and is installed from Git. No temporary local dependency, vendored source, or install-time patch is used. Vite and React dependencies belong to the application, not binduct.
- Step 1 is verified through `apps/frontend/src/use-bound-state.ts` and six real-browser tests in `tests/frontend-binduct.test.ts`. The hook bridges an initial read and a stable subscription callback to React state/effect cleanup. Subscriptions construct fresh binder expressions per setup; arrays combine independent whole-value and update registrations. No additional state owner or observer registry exists.
- The User clarified: "it is not intended to save the binder function and reuse it later." Construct fresh binder expressions inside each subscription setup. A stable subscription function is appropriate when it creates bindings afresh on each call. The earlier cached-binding reproductions are outside intended usage, not unresolved defects requiring a cache or library repair.
- Step 1 RED observed six behavioral failures against the valid initial-read-only skeleton; GREEN and Lead post-review regression pass all six, including development StrictMode cleanup/remount, source changes, nested replacement, arrays and independent trees. Its application gate passed 255 tests, build, frontend/test typechecks, lint and whitespace checks. No existing tests were modified or removed for that step.
- Steps 2–5 are integrated in the isolated replacement entry point. One promoted session API serves both frontends through a re-export; the backend, harness, login destinations and session policy are unchanged. Disposable session notifications share the existing browser event channel, and stale responses can remove only their own session token.
- The shell owns only account/topic interaction state in a per-instance binduct tree. Force-mounted topic panels preserve drafts across tabs; account-keyed contents clear private component state across identities. Logout clears selection rather than choosing another account. Canceled sign-in and stale logout errors cannot select or report against a different account.
- Connections reads the retained public directory and discovers only on explicit submission. Published authority cards open the contextual reader. The reader uses retained GET on open, explicit Refresh for observation, exact source attribution, independent media states, HTTP(S) linked references and account/target response guards. Parent callback changes do not restart reads. React Aria pending buttons preserve focus so Escape works during login and after reader refresh.
- The affected Steps 2–5 browser suites pass 58 tests, including two integrated application flows with real styles and exact-session isolation. The shared full gate passes 312 tests plus build, typechecks, lint and whitespace checks. Integration also preserves the served frontend's sign-in/logout status against notification-triggered retained-read races using its existing revision counter. Other topics remain honest placeholders; typed resource pickers and editors begin with Step 6. Existing product serving and Docker artifact paths are unchanged, and User usability acceptance remains separate.
- Vite reports a non-failing chunk-size warning for the isolated replacement artifact (575.64 kB minified JavaScript, 172.25 kB gzip). No performance acceptance is inferred from this build; bundle optimization was not added to this batch.

Dependency import/setup failures were not treated as behavioral RED evidence. Application tests that do not import binduct do not establish consumption of the local repair.
