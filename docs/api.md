# Local HTTP API reference

> This document is a workflow-oriented reference. The normative server/client contract is the [Common Realms Client-Server Basic API Conventions](local-api-specification.md).

All routes below are local demo APIs under `/local/`, not standardized FCTP endpoints. JSON bodies are objects. Use `Authorization: Bearer <credential>`; administrative credentials are separate per service from the Player's native token and Territory-specific diplomatic bearer tokens. See [the client walkthrough](client-walkthrough.md) for form workflows.

## Authority (port 4100)

`GET /local/info` and `GET /local/home/endpoints` are public discovery routes. `/local/info` includes `name`, the configured server display name. `GET /local/registry/state` requires the authority admin credential and returns Registry state including vessel, requests, events, cargo and ExitEvent references.

### Player authoring

The experimental authoring routes use the authenticated Player's native token (`Authorization: Bearer <nativeToken>`), never a caller-supplied Player, creator, holder, object ID, or administrator credential. Responses are `Cache-Control: no-store`. `GET /local/repository/authoring` returns `{ actor, assets, varieties, grants }` for only that Player. `POST /local/repository/authoring/assets` accepts `{ name: string, text: string }` and returns `201 { asset, activity }`. `name` must be nonempty; `text` is stored as inert text and exposed through the Asset's single `text/plain` media URI.

`POST /local/repository/authoring/varieties` accepts `{ name: string, mass: number, version: string, asset?: URI, production?: Production[] }` and returns `201 { variety, activity, grant? }`. Name and version must be nonempty, mass must be finite and positive (fractional values are accepted), and production defaults to `[]` and is validated against the protocol runtime `Production` shape while retaining extension fields. If `asset` is supplied, it must be an Asset authored and held by this same Player; success creates a corresponding `AssetGrant` for the Player and Variety in the same commit, returned as `grant`.

Missing or invalid native authentication returns `401`; malformed JSON, non-object bodies, invalid fields, and unsupported top-level keys return `400` without authoring mutation. A reference to an Asset not owned by the authenticated Player returns `403` without mutation. Signing and persistence failures propagate as server failures. The Player Actor exposes a public `creations` link to `/objects/players/<name>/creations`, an OrderedCollection of that Player's published Assets, Varieties, and AssetGrants. The objects, collection, text media, and public Outbox are public resources; native-auth catalog scoping does not make published output secret. Local publication records signed Create Activities in the Player Outbox with an empty recipient list and does not enqueue delivery. No remote subscriber delivery is implied. Optional Production is descriptive data: it does not install a Territory rule or generate cargo.

The rendered client exposes Asset text controls from a loaded public `creations` collection, so a non-owner can read published text. Each control attempts the public media GET without credentials first; only a `401` or `403` with a native token falls back to the Actor-scoped authenticated read. `404` and other failures remain visible.

| Route | Credential | Request | Response |
|---|---|---|---|
| `POST /local/home/issue` | Authority admin | Optional `{ "actor": "<Player URI>" }` | `200 { actor, nativeToken }` |
| `POST /local/home/rotate` | Authority admin | Optional `{ "actor": "<Player URI>" }` | `200 { actor, nativeToken }` |
| `POST /local/home/digest-request` | Authority admin | `{ "resourceActor": "<Territory Actor URI>" }` | `202 { "status": "queued" }` |
| `POST /local/home/revoke` | Authority admin | `{ "resourceActor": "<Territory Actor URI>" }` | `202 { "status": "queued" }` |
| `GET /local/home/vessels` | Player native token | None | `200 { actor, vessels, initialVessel? }`, containing only Registry vessels possessed by the authenticated Player |
| `GET /local/home/permissions` | Authenticated native or Home diplomatic token | None | `200 { "<home authority handle>": ["admin"] }` for an administrator, otherwise `{ "<home authority handle>": [] }` |
| `GET /local/home/administration` | Player native token | None | `200 { actor, entries }` containing the account's verified administration entries |
| `POST /local/home/administration` | Player native token | `{ authorityId }` | `200 { entry }` after Home verifies the target permission map; `403 target-unauthorized` if the target rejects the account's credential; `403 not-administrator` if the target authenticates the account without `admin` |
| `GET /local/registry/permissions` | Registry diplomatic token | None | `200 { "<registry authority handle>": ["admin"] }` for an administrator, otherwise `{ "<registry authority handle>": [] }` |
| `GET /local/home/proxy?uri=<URI>&resourceActor=<Actor URI>` | Player native token | Query parameters | `200` resource JSON or upstream authorization/not-found status |
| `POST /local/registry/vessels` | Player native token | `{ id, name, port }`; `id` is a local vessel identifier, not a URI | `202 { vessel, request }` with the generated Vessel and `VesselCreationRequest` |
| `POST /local/registry/entry` | Authority admin | `{ territory, port, route, cargo? }`; cargo is optional `CargoManifest` | `202` created `EntryRequest` |
| `POST /local/registry/departure` | Authority admin | `{ territory, port, route? }` | `202` created `DepartureRequest` |
| `POST /local/registry/adoption` | Authority admin | `{ "adoption": boolean }` | `200` empty response |

`POST /local/registry/entry` and departure validate required string IDs; the Registry resolves the destination Actor/Inbox and persists the request with its outgoing delivery. Omitting cargo uses current Registry cargo.

The Home vessel listing may include `initialVessel: { available, registry, capacity, startingPorts }`. The offer comes from retained configuration and the account's Registry provider; it performs no world IO. `available` is false when the account already possesses a Registry vessel or has been issued an initial vessel. `startingPorts` are recommended published Port URIs. A recommendation is not permission, reachability, or berth evidence.

`POST /local/registry/vessels` requires the authenticated Player's native token and accepts only `id`, `name`, and `port`. The Registry generates the canonical vessel URI, assigns the caller as possessor, capacity 100, and an empty cargo manifest, and validates that `port` is currently recommended and that the exact published Port and Territory Actor resolve. It persists the vessel and a distinct `VesselCreationRequest` in the same durable commit and returns `202 { vessel, request }`. The request has no route, journey, or exit evidence, and the vessel is initially unlocated. Registration acceptance is not a berth; a `BerthingEvent` for the exact creation request is the completion evidence. The destination Territory must admit the Registry through `vesselBuildingRegistry`; `trustedRegistry` and evidence-bearing entry lists do not govern creation. Unknown or overriding fields, malformed identifiers, an unrecommended Port, and an account that already possesses a Registry vessel are rejected. No automatic retry, recovery, replacement destination, or reallocation is provided after an uncertain registration.

The permission-map routes require authentication. Missing or invalid credentials return `401`; an authenticated caller without `admin` receives the authority actor key with an empty role list. The key is the authority actor's published handle, which contains the required dot.

## Territory A — policy (port 4101)

`GET /local/territory/info` is public and returns `{ kind, name, actor, ids, endpoints, production }`, where `name` is the configured server display name. `GET /local/territory/state` requires a Player diplomatic token or A admin credential and returns `{ state, admission, decisions }`. A Territory accepts token declarations only from the Home resolved for the Player Actor's origin through NodeInfo 2.1 `metadata.homeAccountName` and canonical WebFinger. The resolved Home may use another origin; neither a guessed `/actors/home` path nor local enrollment grants issuer authority. No server or user allowlist is configured.

| Route | Credential | Request | Response |
|---|---|---|---|
| `POST /local/territory/mine` | Player diplomatic token | `{ count, variety? }`; optional variety must be A ore | `200` operation result or `409` domain rejection |
| `POST /local/territory/manufacture` | Player diplomatic token | `{ count, recipe: "ore-to-metal" }` | `200` result or `409` domain rejection |
| `POST /local/territory/transfer` | Player diplomatic token | `{ direction: "to-port" | "to-warehouse", variety, count }` | `200` result or `409` domain rejection |
| `POST /local/territory/load`, `/local/territory/unload` | Player diplomatic token who possesses the active visit | `{ vessel, variety, count }` | `200` result or `409` domain rejection |
| `GET /local/territory/permissions` | Territory diplomatic token | None | `200 { "<territory authority handle>": ["admin"] }` for an administrator, otherwise `{ "<territory authority handle>": [] }` |
| `POST /local/territory/admin/policy` | A admin credential | Persisted policy object with mining permission/quota/reserve, recipe/permits, limits, optional `varietyPortPolicy` and decisions | `200` update result; `400` invalid policy |
| `POST /local/territory/admin/admission` | A admin credential | Partial admission object: `trustedRegistry`, `acceptedRegistry`, `acceptedTerritory`, and `vesselBuildingRegistry`, each `{ mode: "allowlist" | "denylist", allowlist: URI[], denylist: URI[] }`, plus preserved `reviewMode`, `publicPorts`, and `mismatchPolicy` | `200 { admission }`; `400` invalid input |

Player-initiated A mine, manufacture, transfer, load, and unload operations record the authenticated Player URI in local audit entries. Registry entry `prepare-vessel` and departure `exit-vessel` record the verified Registry sender; internal and action-discovery preview operations default to `system`. Attribution does not change authorization.

`varietyPortPolicy` is an optional local A permit map keyed by absolute `http` or `https` canonical Variety URIs without credentials. A missing entry means allow; `deny` rejects `load` or `unload` of that exact variety before port inventory or vessel manifest changes, with an attributed rejection. The permit does not create, modify, or register a Variety object, is not an FCTP field, and has no B equivalent. Policy validation returns `400` for malformed keys or decisions other than `allow` or `deny`.

Player credentials identify a Player whose token declaration was issued by its discovered Home; load/unload additionally require that Player to match the active visit possessor. An administrator credential alone cannot operate cargo. Invalid credentials return `401`; authenticated but unauthorized cargo access returns `403`; unknown `/local/` paths return JSON `404`. Invalid JSON/operation fields return `400`; valid operation requests rejected by local domain conditions may return `409`.

## Territory B — simulation (port 4102)

`GET /local/territory/info` is public. `GET /local/territory/state` accepts a Player diplomatic token or B admin credential and returns simulation state including ticks, jobs, inventories, vessels and visits. Simulation uses the same NodeInfo/WebFinger Home issuer validation as Policy; admission is controlled by the four lists below.

| Route | Credential | Request | Response |
|---|---|---|---|
| `POST /local/territory/mine` | Player diplomatic token | `{ count, duration? }`, duration in local ticks | `200 { job }` |
| `POST /local/territory/manufacture` | Player diplomatic token | `{ count, recipe: "native" | "imported" }` | `200 { job }` |
| `POST /local/territory/load`, `/local/territory/unload` | Player diplomatic token matching visit possessor | `{ entryRequest, cargo: { entries: [...] }, duration }` | `200 { job }` |
| `GET /local/territory/permissions` | Territory diplomatic token | None | `200 { "<territory authority handle>": ["admin"] }` for an administrator, otherwise `{ "<territory authority handle>": [] }` |
| `POST /local/territory/admin/facilities` | B admin credential | Partial validated facility sections: `mining`, `manufacturing`, `port` | `200 { ok: true }` |
| `POST /local/territory/admin/tick` | B admin credential | `{}` (body is read for POST) | `200` tick result |
| `POST /local/territory/admin/admission` | B admin credential | Partial admission object: `trustedRegistry`, `acceptedRegistry`, `acceptedTerritory`, and `vesselBuildingRegistry`, each `{ mode: "allowlist" | "denylist", allowlist: URI[], denylist: URI[] }`, plus preserved `reviewMode`, `manifestPolicy`, and `requireExitEvidence` | `200 { admission }`; `400` invalid input |

Cargo entries preserve Item (`{ id, variety, data }`) versus Stack (`{ variety, count, data }`) identity. Jobs reserve applicable inputs/capacity and complete only as ticks advance. Valid credentials without permission return `403`; absent/invalid credentials return `401`; invalid bodies return `400`. Unknown paths return `404`. Resource retrieval may return `406` for an unsupported requested representation/format; the browser currently supports the local ASCII map format and text assets. Protected resource requests also use standard `401` unauthenticated, `403` denied and `404` missing-resource responses.

## Browser and service setup

The launcher serves the client at `http://127.0.0.1:4103`; default services are loopback HTTP on ports 4100–4102. Admin service secrets default to `demo-authority-admin`, `demo-policy-admin`, and `demo-sim-admin`; environment overrides are `DEMO_AUTHORITY_ADMIN_SECRET`, `DEMO_POLICY_ADMIN_SECRET`, and `DEMO_SIM_ADMIN_SECRET`. `FCTP_DATA_DIR` changes the default persistent `.fctp-data` directory, including `client.store.json` and the world stores. The demo provisions two Players and a governor account with development passwords documented in the [browser harness guide](browser-harness.md#start-the-local-demo); passwords are entered through the client application or harness login and are not part of public configuration.

## Client application sessions

The client server also serves application routes under `/api/` at the client origin. These are separate from the `/local/` world APIs above; the world APIs keep their native, diplomatic, and administrator authentication.

`POST /api/accounts/login` accepts `{ handle, password }` and returns the public account/login state plus a client session token (`clientToken`, S). The handle determines the destination host and port. Login uses HTTPS by default and HTTP only for loopback hosts (`localhost`, IPv4 `127/8`, and IPv6 `::1`); there is no caller-supplied origin override. The Home-issued native token (T) stays in client web server account state and is never returned to the browser or harness. Account-scoped application requests use `Authorization: Bearer S` for the handle bound to that session. Multiple S sessions may coexist for one account and across accounts.

`GET /api/accounts` requires Bearer S and returns only the authenticated session's own account, never another account or a credential projection. Logout deletes only the current S and, when no S remains for the handle, clears the client login state; it does not revoke T at Home. Client sessions have no implicit expiry, and Home availability changes do not synchronize to existing sessions.

`GET /api/administration?accountId=...` checks the account's Home `/local/home/administration` entries when the Administration tab is opened. Home verifies administration claims; the Client only resolves target identity. `POST /api/administration/claim` accepts exactly one of two input shapes. `{ accountId, authority }` takes a Home server domain (optional port; HTTPS except an exact loopback host over HTTP) and resolves its published Home through NodeInfo 2.1 and WebFinger, or takes an `@name.home@server`, `@name.registry@server`, or `@name.territory@server` handle and resolves that exact Home, Registry, or Territory authority. The response adds a top-level `authorityId` naming the resolved target alongside the existing page envelope. `{ accountId, authorityId }` remains the exact-target application caller seam and skips target resolution. Normal response identity enrichment applies to both shapes. Invalid input, unsupported roles, and role mismatches return `400`; a target that cannot be resolved returns `502`. In both shapes the Client then asks the account's own Home to verify and store an administration entry using the exact `authorityId`; Home remains the verifier and the target remains authoritative. If the target rejects the account's derived credential, Home returns `403 target-unauthorized`; a verified target that simply does not grant `admin` returns `403 not-administrator`. These outcomes are distinct: the former means the target credential is missing or invalid, while the latter means the account was authenticated but lacks administrator permission.

### Initial vessel candidates and submission

`GET /api/logistics/vessels?accountId=...` returns the retained vessel-candidate page envelope. Its `data` contains `accountId`, `candidates`, `blockers`, and, when configured for the account, `initialVessel` and `startingPorts`. `initialVessel` is a sourced observation of `{ available, registry, capacity, startingPorts }` from the account's Home vessel listing. Each `startingPorts` entry carries `portId`, the exact Port `port` observation `{ id, name?, territory }`, and an optional Territory `authority` observation `{ id, role: "territory", name? }`. The retained GET performs no world IO and does not refresh Home or recommendations. Stale, unavailable, and error observations remain independent and visible; they are not inferred into permission.

`POST /api/logistics/vessels/refresh` explicitly observes the account's Home vessel listing and each recommended Port and Territory Actor. Public Port and Actor reads are credential-free, no-store, and must not follow redirects. Successfully resolved Territory Actors are remembered through the Client's existing discovery owner. Either a Port or its Actor may fail independently without fabricating the other.

`POST /api/logistics/vessels` accepts only `{ accountId, vesselId, name, portId }` and returns `{ action: ActionRecord }`. `vesselId` is the local identifier, not a URI; `portId` is a recommended Port URI. Session and account authorization precede world IO. Unknown or override fields and malformed values are rejected before send. The Client revalidates a fresh Home offer before native registration: the offer must be current and available for this account, the Registry must be the account Home Registry, and the Port must be a current recommendation. The native registration credential is sent only to the guarded Home-origin Registry route.

An accepted or pending action does not mean the vessel is located or berthed. The UI exposes the form only for a current available offer and shows observed names, freshness, and errors without inferring permission; only valid current Port and Actor options may be submitted. After acceptance, the Client selects the returned exact vessel resource and preserves account and action generations. Reconciliation uses the retained resource and creation-request references and the exact Registry state, matching `BerthingEvent` or `EntryRejected`; a lost or uncertain outcome remains unverified and is never replayed or associated by a guessed local-ID URI. Completion requires the matching `BerthingEvent`; there is no automatic refresh, tick, retry, replacement destination, reallocation, or recovery for a rejected landing.

Initial landing follows the Territory's vessel-entry review setting: manual entry review also requires manual approval of creation landing. Simulation still requires an explicit tick after approval to berth the vessel.

Future requirement: after definitive landing rejection, the player can choose another Home-recommended starting Port for the same registered, unlocated vessel and request landing again. This recovery workflow is not implemented; it does not authorize automatic replay of an uncertain submission or allocation of another initial vessel.
