# Common Realms Client-Server Basic API Conventions

## Scope of This Document

This document defines the basic conventions between Common Realms constituent servers and clients. Servers and clients MAY follow this convention to enhance client-server compatibility. Compliance to this convention is NOT required to join Common Realms federation by FCTP protocol.

Communications between servers are defined in FCTP federation protocol, and outside this document.

## 1. Introduction

Common Realms consist of servers of different FCTP roles: Home, Registry, Territory, and Repository of Assets and Varieties. To serve the functionality the roles expect, servers may expose a set of HTTP API under `/local/`. To name a few, the local API carries account authentication, vessel registration, entry and departure requests, Territory operations, administrative controls.

The Common Realms Client-Server Basic API Conventions, shortly the Basic API, is a defined set of APIs to serve this purpose. Browser clients, backend-server clients, or native clients may access to the Basic API.

## 2. Conformance and Terminology

### 2.1 Requirement language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, NOT RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals.

The JSON and TypeScript shapes in this document describe the wire contract. TypeScript syntax is used for precision and does not require an implementation to use TypeScript.

### 2.2 Terms

Terms are mostly defined in the FCTP protocol.

**Server.** A Common Realms server implementing one or more roles in this document.

**Client.** A client software which calls the Basic API and acts for signed-in accounts.

**Home server.** A server that provides account login and Home-local APIs.

**Registry server.** A server that maintains a vessel registry.

**Repository server.** A server that provides authoring and publication APIs for Assets and Varieties.

**Territory server.** A server that provides local territorial operations and administration. Policy and simulation endpoints are optional endpoint groups that a Territory server MAY provide.

**Account.** A Home login identity. An account resolves to a Player Actor.

**Administrator.** An account authorized by a server to perform administrative operations on the authority.

**Vessel possessor.** The Player Actor identified by a vessel's `possessor` member.

## 3. Server Roles

The Basic API defines four independent server roles: Home, Registry, Repository, and Territory. A server MAY implement one or more roles. The convention does not require any role to be bundled with another, and it does not prescribe whether roles share an origin, process, or storage.

A server that implements any role MUST publish a canonical origin.

### 3.1 Home role

A server that implements the Home role MUST provide the routes defined in Section 8.

### 3.2 Registry role

A server that implements the Registry role MUST provide the routes defined in Section 9.

### 3.3 Repository role

A server that implements the Repository role MUST provide the authoring routes defined in Section 10.

### 3.4 Territory role

A server that implements the Territory role MAY provide any subset of the endpoints defined in Sections 11 and 12. Each endpoint is optional, and a Territory server MUST satisfy the requirements for each endpoint it provides. Policy and simulation endpoints are endpoint groups, not separate server roles. Combinations of endpoints may impose runtime dependencies that this convention does not prescribe. Where two endpoint groups define the same path with different semantics, a Territory server MUST select one semantics for that path and MUST NOT expose conflicting variants of it.

### 3.5 Client role

A Client that implements this convention MUST follow the requirements in Section 14. A Client MAY support any subset of server roles and optional endpoints, but it MUST NOT call a route that the selected server does not provide.

## 4. Transport and Message Rules

### 4.1 HTTP

Basic API routes use HTTP. Non-loopback deployments MUST use HTTPS. A Client MUST NOT send authentication material over cleartext HTTP except for a loopback development deployment where the operator has accepted that risk. A server MUST publish a canonical origin.

The path portion of a Basic API route is relative to the server's canonical origin. Clients MUST call the canonical origin and MUST use the exact path and method defined for the route. A server MUST generate all object and Actor identifiers using its canonical origin.

### 4.2 JSON

Request bodies and response bodies are JSON objects unless a route states otherwise. A route that reads a JSON request body MUST reject a non-object body with `400`. Responses with a JSON body MUST use `Content-Type: application/json`; clients SHOULD send `Content-Type: application/json` on requests with a JSON body.

Servers MAY include additional members in response objects beyond those defined in this document. Clients MUST ignore members they do not understand. Unless a route explicitly says otherwise, servers MUST ignore unknown members in request objects.

Server responses and request bodies MAY be subject to a size limit. A server that imposes a limit MUST reject an oversized body with `400`. Territory servers MUST accept bodies up to 16 KiB.

### 4.3 Permission labels

Each route table specifies a required permission; Section 5 defines the values.

### 4.4 Status codes

Servers SHOULD use the following status codes with the meanings below.

| Status | Meaning |
|---|---|
| `200` | The request succeeded. |
| `201` | A resource was created. |
| `202` | The request was accepted for later processing. It does not mean the requested effect is complete. |
| `400` | The request is malformed or invalid for the route. |
| `401` | Authentication is missing or invalid, or the route reports an authentication failure with `401`. |
| `403` | The caller lacks the required permission. |
| `404` | The route, resource, vessel, or request does not exist. |
| `409` | The request is valid but was rejected by local domain rules. |
| `500` | The server failed to complete a local operation. |
| `502` | A required upstream Actor or metadata source is unavailable or invalid. |

### 4.5 Error bodies

A JSON error response SHOULD have the form:

```json
{ "error": "machine-readable-code" }
```

Clients MUST rely on the HTTP status code and MUST NOT require an error body. Some routes, especially Registry routes, return a status-only error. Home login uses `HomeLoginResult` rather than `{ "error": ... }`.

### 4.6 Caching

Clients MUST NOT cache authenticated Basic API responses unless a route explicitly permits caching. Servers SHOULD send `Cache-Control: no-store` for authenticated Basic API responses.

## 5. Required Permission

An administrator is an account authorized by the target server's deployment configuration to perform administrative operations on that server. Administrator permission is target-specific.

Each route table uses one of the following values:

| Permission | Meaning |
|---|---|
| `none` | No Player or administrator permission is required. |
| `player` | The caller must act for an authenticated Player. |
| `administrator` | The caller must be an administrator of the target server. |

Authentication and how a caller proves permission are implementation-defined and outside this convention. A server MUST reject a request that lacks the required permission.

An administrator MAY use a route marked `player` when the route's requirements explicitly allow administrator access.

A Client MUST NOT infer administrator permission from an account name, a Home administration entry, or a UI selection. A permission map is informational; reading it MUST NOT be treated as permission for an administrative operation.

### 5.1 Player-scoped constraints

Registry routes marked `player` that operate on a vessel MUST require the selected vessel's `possessor` to equal the authenticated Player.

Territory cargo endpoints marked `player` MUST require the active local visit's possessor to equal the authenticated Player.

## 6. State, Observation, and Completion Semantics

### 6.1 Retained state

Unless a route explicitly states that it observes an external resource, a `GET` route returns the server's retained local state. A `GET` route MUST NOT advance simulation time.

Only the optional simulation tick endpoint `POST /local/territory/admin/tick`, when a Territory server provides it, advances the simulation tick.

### 6.2 Accepted requests

A `202` response, or any response indicating that a request was accepted, means that the server recorded the request. It does not mean that a later world effect has completed.

A response that carries a resulting local state or an authoritative local event may establish the local effect it describes. It MUST NOT be treated as completion of a downstream Registry or Territory effect.

A Client MUST NOT treat an accepted entry request as a berth, an accepted departure request as a departure, an accepted cargo operation as a cargo change, or an accepted publication as a completed publication.

### 6.3 Completion evidence

A Client MUST require the corresponding event or observation before claiming completion. In particular:

- a berth requires a `BerthingEvent` for the exact entry request;
- a rejection requires an `EntryRejected` event;
- a Registry departure requires the applicable Registry event and, where required, signed exit evidence;
- a cargo or production operation requires the resulting state or event;
- a publication requires an available public resource with matching identity and evidence.

A missing event is not proof that the effect did not happen, but it is also not proof that it happened. A Client MUST represent such a state as unverified or pending.

### 6.4 Exact identifiers

Object identifiers, Actor identifiers, vessel identifiers, route identifiers, request identifiers, and operation identifiers are absolute URIs. Clients MUST use the exact identifiers returned by servers and MUST NOT construct, shorten, or guess them from URL tails, display names, or local numeric IDs. Clients MUST NOT derive a published handle from an Actor URI, a WebFinger subject, or a URL tail.

A numeric job identifier or operation identifier is local to its authority and MUST NOT be treated as globally unique.

Route direction is explicit. A Client MUST NOT reverse a route's `from` and `to` endpoints, invent a reverse edge, or treat the existence of a route or connection as permission to traverse it.

### 6.5 Action discovery

`LocalActionDiscovery` responses are advisory. Action availability, request bodies, and effects describe a possible operation at the time the response was assembled. A Client MUST treat execution as authoritative and MUST NOT assume that an action remains available after the response is generated. The existence of a route or action MUST NOT be treated as permission.

Action discovery MUST NOT be used as a substitute for state reads or completion evidence.

### 6.6 Retries and ambiguous outcomes

`POST` routes are not generally idempotent. A Client MUST NOT automatically replay a `POST` after an ambiguous failure, timeout, or lost response. The Client MUST reconcile the exact request, action, or resource reference before retrying.

A `GET` may be retried when the Client needs a fresh retained read. Retrying a `GET` MUST NOT be treated as permission to advance simulation time or mutate state.

### 6.7 Discovery advertisements

A server MUST implement any discovery route required by the role or endpoint it provides. The content of an endpoint advertisement is advisory. It MAY omit routes defined by this convention and MAY describe required permission approximately. A Client MUST NOT treat an advertisement as an exhaustive route list, a permission decision, or a reachability guarantee. Clients MUST use the route definitions in this document.

## 7. Data Types

### 7.1 Identifiers

A URI is an absolute URI string. `ActorId`, `vesselId`, `territoryId`, `portId`, `routeId`, `requestId`, `operationId`, and `jobId` values are URIs unless a route states that a value is a local numeric identifier.

### 7.2 Admission list

```ts
interface AdmissionList {
  mode: 'allowlist' | 'denylist';
  allowlist: string[];
  denylist: string[];
}
```

An allowlist permits only listed URIs. A denylist permits every URI not listed.

### 7.3 Admission policy

```ts
interface AdmissionPolicy {
  trustedRegistry: AdmissionList;
  acceptedRegistry: AdmissionList;
  acceptedTerritory: AdmissionList;
  vesselBuildingRegistry: AdmissionList;
}
```

Required defaults:

| Field | Mode | Initial lists | Effect |
|---|---|---|---|
| `trustedRegistry` | `allowlist` | empty | Permits no Registry |
| `acceptedRegistry` | `denylist` | empty | Permits any Registry |
| `acceptedTerritory` | `allowlist` | empty | Permits no evidence Territory |
| `vesselBuildingRegistry` | `allowlist` | empty | Permits no Registry; vessel creation is not defined by this convention |

Entry without exit evidence MUST be governed by `trustedRegistry`. Entry with exit evidence MUST be governed by `acceptedRegistry` for the vessel's Registry and `acceptedTerritory` for the evidence Territory.

The policy endpoint group additionally preserves `mismatchPolicy`, `reviewMode`, and `publicPorts`. The simulation endpoint group additionally preserves `manifestPolicy`, `reviewMode`, and `requireExitEvidence`.

### 7.4 Local action discovery

```ts
interface LocalActionDiscovery {
  kind: 'registry' | 'policy' | 'simulation';
  actor: string;
  player: string;
  vessel: string;
  observedAt: string;
  state: Record<string, unknown>;
  actions: LocalAction[];
  notes: string[];
}

interface LocalAction {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  request?: {
    method: 'GET' | 'POST';
    href: string;
    body?: Record<string, unknown>;
  };
  effect: string;
}
```

`observedAt` is the time the local response was assembled. It is not a world tick or a completion timestamp.

### 7.5 Policy operation result

```ts
type OperationResult =
  | { success: true; state: TerritoryState }
  | { success: false; state: TerritoryState; error: string };
```

A successful operation returns `200`. A domain rejection returns `409`. Invalid request shape returns `400`.

### 7.6 Home login result

```ts
type HomeLoginResult =
  | { status: 'signed-in'; handle: string; actorId: string }
  | { status: 'rejected' | 'unavailable'; handle: string; reason: string };
```

### 7.7 Administration entry

```ts
interface AdministrationEntry {
  authorityId: string;
  authorityHandle: string;
  roles: string[];
  permissions: string[];
  verifiedAt: string;
}
```

An administration entry is Home's retained claim that the account was verified as an administrator of the target. It is not a permission grant, and it does not replace target-side enforcement.

### 7.8 Registry state

```ts
interface VesselRegistryState {
  vessel?: Vessel;
  cargo?: CargoManifest;
  adoption: boolean;
  requests: Record<string, Record<string, unknown>>;
  events: RegistryEvent[];
  eventIds: Record<string, true>;
  exitEvidence: string[];
}
```

A `RegistryEvent` is an FCTP event recorded by the Registry for the vessel, including entry, rejection, berthing, departure, and exit evidence events. The exact event schemas are defined by the FCTP protocol specification.

### 7.9 Policy state view

The policy state endpoint (`GET /local/territory/state`) returns:

```ts
interface PolicyStateView {
  state: TerritoryState;
  admission: AdmissionPolicy & {
    mismatchPolicy: string;
    publicPorts: string[];
    reviewMode?: 'automatic' | 'manual';
  };
  decisions: Record<string, EntryDecision>;
}

interface EntryDecision {
  request: string;
  accepted: boolean;
  reason?: string;
  verification: unknown;
  policy: Policy & { admission: AdmissionPolicy };
  evidence?: unknown;
}

interface Policy {
  miningPermitted: boolean;
  miningQuota: number;
  oreReserve: number;
  manufacturePermits: string[];
  recipes: Recipe[];
  warehouseLimits: Record<string, number>;
  portLimits: Record<string, number>;
  decisions: Record<string, 'allow' | 'deny'>;
  varietyPortPolicy?: Record<string, 'allow' | 'deny'>;
}

interface Recipe {
  id: string;
  output: string;
  outputCount: number;
  ingredients: Record<string, number>;
}

interface Commodity {
  variety: Variety;
  mass: number;
}

interface TerritoryState {
  policy: Policy;
  commodities: Record<string, Commodity>;
  rawInventory: Record<string, number>;
  productionReservations: Record<string, number>;
  portInventory: Record<string, number>;
  vessels: Record<string, { capacity: number; manifest: CargoManifest }>;
  audit: Array<{
    actor: string;
    action: string;
    outcome: 'accepted' | 'rejected';
    details: Record<string, unknown>;
  }>;
}
```

`EntryDecision` records the verification and policy context used for an entry decision. Its exact contents are defined by the policy endpoint group, but it MUST identify the request and whether the request was accepted.

### 7.10 Simulation state view

The simulation state endpoint (`GET /local/territory/state`) returns a `SimulationTerritoryState` containing at least:

- `simulation`: the simulation state, including tick, stock, facilities, jobs, and vessels;
- `visits`: admitted local visits keyed by entry request;
- `decisions`: retained decision records;
- `evidence`: retained exit evidence;
- `admission`: the simulation admission policy;
- `requests`: retained entry request records.

Clients MAY use additional server-defined members but MUST NOT depend on their presence for permission.

### 7.11 FCTP objects

Requests and responses may contain FCTP objects defined by the FCTP protocol specification, including `Asset`, `Variety`, `AssetGrant`, `Vessel`, `CargoManifest`, `EntryRequest`, `DepartureRequest`, `EntryRejected`, `BerthingEvent`, `DepartureEvent`, `ExitEvent`, and `VoyageEvent`.

## 8. Home

A Home server MUST implement the following routes.

| Method and path | Required permission | Request | Success |
|---|---|---|---|
| `GET /local/home/endpoints` | none | None | `200 { endpoints: Array<{ method, path, permission }> }` |
| `GET /local/home/vessels` | player | None | `200 { actor, vessels: Vessel[] }` |
| `GET /local/home/permissions` | player | None | `200 { "<home-handle>": string[] }` |
| `GET /local/home/administration` | player | None | `200 { actor, entries: AdministrationEntry[] }` |
| `POST /local/home/administration` | player | `{ authorityId: string }` | `200 { entry: AdministrationEntry }` |
| `GET /local/home/accounts` | administrator | None | `200 { accounts: Array<{ handle, actorId, available }> }` |
| `POST /local/home/accounts/availability` | administrator | `{ handle: string, available: boolean }` | `200 { handle, actorId, available }` |
| `POST /local/home/login` | none | `{ handle: string, password: string }` | `200` with `HomeLoginResult` |
| `GET /local/home/proxy?uri=<URI>&resourceActor=<Actor URI>` | player | Query parameters | `200` with the upstream resource JSON |

### 8.1 Home vessel list

`GET /local/home/vessels` MUST return only Registry vessels whose `possessor` equals the authenticated Player's Actor ID. It MUST NOT be treated as a full Registry fleet listing.

The route MUST return `401 { "error": "unauthorized" }` for missing or invalid `player` permission. It MUST return `500 { "error": "vessel-listing-failed" }` if the owned-vessel listing fails.

### 8.2 Home permission map

The response key MUST be the Home Actor's published WebFinger handle. The value MUST be `["admin"]` for an account with administrator permission. Otherwise the value MUST be `[]`.

The route MUST return `401 { "error": "unauthorized" }` for missing or invalid `player` permission. It MUST return `500 { "error": "actor-handle-unavailable" }` if the Home Actor has no published handle.

### 8.3 Home administration entries

`GET /local/home/administration` MUST return the authenticated account's retained entries. `POST /local/home/administration` MUST verify the target before storing an entry.

The POST request's `authorityId` MUST be an absolute HTTP(S) Actor URL with no userinfo, query, or fragment. Home MUST fetch that Actor without authentication, require `id` to equal `authorityId`, and require `role` to be `home`, `registry`, or `territory`. Home MUST call the target's `/local/<role>/permissions` route using the account's permission for that target.

Home MUST store an entry only when the target permission map reports `admin`. Errors:

| Status | Error | Condition |
|---|---|---|
| `400` | `invalid-request` | Malformed JSON or non-object body |
| `400` | `invalid-authority` | Invalid URI, Actor document, ID, or role |
| `401` | `unauthorized` | Missing or invalid `player` permission, or no retained Home player state |
| `403` | `not-administrator` | Target reports no `admin` role for this account |
| `502` | `target-actor-unavailable` | Target Actor cannot be fetched |
| `502` | `target-permissions-unavailable` | Target permission route fails other than `401` |
| `502` | `invalid-target-permissions` | Target permission response is not an object, or its handle conflicts with the Actor's published handle |

A successful POST MUST mutate only the authenticated account's retained administration entries. It MUST NOT change target permission.

### 8.4 Home accounts and availability

`GET /local/home/accounts` MUST return the configured accounts and their availability. `POST /local/home/accounts/availability` MUST change one local account's availability.

The availability request MUST contain a `handle` for a local Home account and a boolean `available`. A caller MUST NOT be able to make itself unavailable. Disabling an account MUST invalidate its active authentication state and MUST cause any required revocation declaration to be queued for known resources. Re-enabling an account MUST require a fresh login.

Errors:

- `401 { "error": "unauthorized" }` for a caller without administrator permission.
- `400 { "error": "invalid-request" }` for malformed JSON, a non-object body, or missing or mistyped fields.
- `400 { "error": "invalid-target" }` for a foreign or unknown handle, a non-Player account, or self-disable.

### 8.5 Home login

`POST /local/home/login` MUST accept `{ handle, password }` and return `HomeLoginResult`.

- Missing or empty fields, malformed JSON, or a non-object body MUST return `400` with `status: "rejected"` and `reason: "invalid-request"`.
- An invalid handle or password MUST return `401` with `status: "rejected"`.
- An unavailable account MUST return `401` with `status: "unavailable"` and `reason: "account-unavailable"`.
- A successful login MUST return `200` with `status: "signed-in"`, the account handle, and the Player Actor ID.

Home MUST accept a password only on `/local/home/login`; no other local route may consume a password.

### 8.6 Home proxy

`GET /local/home/proxy?uri=<URI>&resourceActor=<Actor URI>` MUST require `player` permission and both query parameters. Home MUST fetch the exact resource URI using the Player's permission for `resourceActor`.

Success MUST return the upstream JSON value. A missing parameter MUST return `400 { "error": "uri-and-resourceActor-required" }`. A resource-permission or retrieval failure MUST return the upstream `ResourceError` status with `{ "error": "<code>" }`.

The proxy MUST NOT mutate local world state.

## 9. Registry

A Registry server MUST implement the following routes.

| Method and path | Required permission | Request | Success |
|---|---|---|---|
| `GET /local/registry/permissions` | player | None | `200 { "<registry-handle>": string[] }` |
| `GET /local/registry/fleet` | administrator | None | `200` with the fleet map |
| `GET /local/registry/state?vessel=<URI>` | player | Optional query | `200` with `VesselRegistryState` |
| `GET /local/registry/actions?vessel=<URI>` | player | Required query | `200` with `LocalActionDiscovery` |
| `POST /local/registry/entry` | player | Entry request body | `202` with `EntryRequest` |
| `POST /local/registry/departure` | player | Departure request body | `202` with `DepartureRequest` |
| `POST /local/registry/adoption` | player | `{ adoption: boolean, vessel?: string }` | `200` with an empty body |

### 9.1 Registry access rules

A Registry administrator is an account authorized by the Registry's deployment configuration. An administrator MAY use a route marked `player` when the route's requirements explicitly allow administrator access.

A Player caller MUST be accepted only for a vessel whose `possessor` equals that Player. If `vessel` is omitted, the Registry MUST use the default vessel when the caller is an administrator, or when the Player caller is its possessor.

Registry error responses MAY be status-only. In particular:

- `403` for a failed required-permission or possessor check;
- `404` for an unknown vessel or unavailable state;
- `400` for missing required request strings or a non-boolean adoption value.

`GET /local/registry/permissions` MUST return `401` with an empty body for missing or invalid `player` permission, and `500` with an empty body if the Registry has no published handle. An authenticated non-administrator MUST receive `200` with an empty role array.

### 9.2 Registry state

`GET /local/registry/state` MUST return the selected vessel's `VesselRegistryState`. With an omitted `vessel`, the Registry MUST apply the default-vessel rule in Section 9.1.

The route MUST read retained Registry state and MUST NOT observe the world or advance any state machine.

### 9.3 Registry action discovery

`GET /local/registry/actions` MUST require `player` permission for the selected vessel's possessor. The response MUST include:

- the current retained cargo and adoption flag;
- the latest recorded berth, if any;
- pending entry and departure requests;
- the latest exit evidence;
- available departure and adoption actions.

The response MUST state that location and lifecycle reflect only events recorded by this Registry. Exit evidence MUST NOT be presented as establishing entry elsewhere.

### 9.4 Entry, departure, and adoption

`POST /local/registry/entry` MUST accept:

```json
{
  "territory": "<Territory Actor URI>",
  "port": "<Port URI>",
  "route": "<Route URI>",
  "vessel": "<optional Vessel URI>",
  "cargo": { "entries": [] }
}
```

`territory`, `port`, and `route` MUST be required strings. If `cargo` is omitted, the Registry MUST use the vessel's current cargo. If `cargo` is supplied, the Registry MUST include it as the request cargo, and the Client MUST send a valid `CargoManifest`. The Registry MUST resolve the destination Territory and queue an `EntryRequest`. Success MUST be `202`.

`POST /local/registry/departure` MUST accept `territory` and `port` as required strings and optional `route` and `vessel`. It MUST queue a `DepartureRequest`. Success MUST be `202`.

`POST /local/registry/adoption` MUST accept a required boolean `adoption` and optional `vessel`. It MUST change the retained adoption flag and return `200` with an empty body.

Acceptance of an entry or departure request MUST NOT be represented as completion of the corresponding world effect.

## 10. Repository: Authoring

A Repository server MUST implement the following authoring routes.

| Method and path | Required permission | Request | Success |
|---|---|---|---|
| `GET /local/repository/authoring` | player | None | `200 { actor, assets, varieties, grants }` for the authenticated Player only |
| `POST /local/repository/authoring/assets` | player | `{ name: string, text: string }` | `201 { asset, activity }` |
| `POST /local/repository/authoring/varieties` | player | `{ name, mass, version, asset?, production? }` | `201 { variety, activity, grant? }` |

### 10.1 Asset authoring

The request MUST accept only `name` and `text`. `name` MUST be a nonempty string after trimming. `text` MAY be empty.

Success MUST create an Asset with a single `text/plain` media URI and archive a signed Create Activity. The route MUST NOT enqueue federation delivery. Unsupported top-level keys MUST return `400`.

### 10.2 Variety authoring

The request MUST accept only `name`, `mass`, `version`, `asset`, and `production`.

- `name` and `version` MUST be nonempty strings.
- `mass` MUST be finite and greater than zero.
- `asset`, when supplied, MUST be an absolute URI identifying an Asset authored and held by the same Player. Otherwise the route MUST return `403 { "error": "asset-not-owned" }`.
- `production`, when supplied, MUST be an array of valid FCTP `Production` objects. Invalid production MUST return `400`.
- A supplied Asset MUST cause a matching `AssetGrant` to be created and returned as `grant`.

Published Assets, Varieties, Grants, media, and the Player's public creations collection are public resources. The creation itself MUST NOT enqueue federation delivery.

`Production` data on a Variety is descriptive. It MUST NOT be interpreted as an executable Territory recipe, a job request, or a guarantee that a Territory can perform the described production.

## 11. Territory: Policy Endpoints

The following policy endpoints are optional. A Territory server MAY implement any of them. If it implements an endpoint, it MUST satisfy the corresponding requirements.

| Method and path | Required permission | Request | Success |
|---|---|---|---|
| `GET /local/territory/info` | none | None | `200` with kind, Actor, IDs, endpoints, production |
| `GET /local/territory/permissions` | player | None | `200 { "<territory-handle>": string[] }` |
| `GET /local/territory/actions?vessel=<URI>` | player | Required query | `200` with `LocalActionDiscovery` |
| `GET /local/territory/state` | player | None | `200` with `PolicyStateView` |
| `POST /local/territory/traverse` | player | `{ vessel: string, route: string }` | `200 { success: true, event: VoyageEvent }` or a domain-failure result |
| `POST /local/territory/mine` | player | `{ count: integer, variety?: string }` | `200` with `OperationResult` |
| `POST /local/territory/manufacture` | player | `{ count: integer, recipe: "ore-to-metal" }` | `200` with `OperationResult` |
| `POST /local/territory/transfer` | player | `{ count, variety, direction }` | `200` with `OperationResult` |
| `POST /local/territory/load` | player | `{ vessel, variety, count }` | `200` with `OperationResult` |
| `POST /local/territory/unload` | player | `{ vessel, variety, count }` | `200` with `OperationResult` |
| `POST /local/territory/admin/policy` | administrator | Full policy object | `200` with `OperationResult`, or `400` for invalid policy |
| `POST /local/territory/admin/admission` | administrator | Partial admission object | `200 { admission }` |
| `GET /local/territory/admin/entry-requests` | administrator | None | `200 { requests }` |
| `POST /local/territory/admin/entry-requests/:requestId/approve` | administrator | Optional `{ reason?: string }` | `200` with decision result |
| `POST /local/territory/admin/entry-requests/:requestId/reject` | administrator | Optional `{ reason?: string }` | `200` with decision result |

### 11.1 Permission map

`GET /local/territory/permissions` MUST return `401 { "error": "unauthorized" }` for missing or invalid `player` permission, and `500 { "error": "actor-handle-unavailable" }` if the Territory has no published handle. An authenticated non-administrator MUST receive `200` with an empty role array.

### 11.2 Action discovery

`GET /local/territory/actions` MUST require `player` permission and a parseable `vessel` URI.

If the vessel has no retained local visit, the Territory server MUST fetch the vessel document and MUST require:

- a valid Vessel whose `id` equals the requested vessel;
- the Player to equal the vessel's `possessor`;
- the vessel's Registry to pass `trustedRegistry`.

The response state MUST contain the current policy, shared inventory, production reservations, the vessel's local visit, and cargo. Actions MUST be previews evaluated against a clone of local state; execution MUST revalidate.

Errors:

| Status | Error | Condition |
|---|---|---|
| `401` | `unauthorized` | Missing or invalid `player` permission |
| `400` | `invalid-vessel` | Missing or unparseable vessel query |
| `404` | `vessel-retrieval-failed` | Vessel document returns `404` |
| `400` | `vessel-retrieval-failed` or `invalid-vessel` | Vessel retrieval fails otherwise, or document is invalid |
| `403` | `forbidden` | Player is not the vessel possessor |
| `403` | `registry-not-accepted` | Registry fails `trustedRegistry` |

### 11.3 Policy state

`GET /local/territory/state` MUST return `PolicyStateView` from retained Policy state. It MUST NOT advance time or observe remote state.

### 11.4 Local traversal

`POST /local/territory/traverse` MUST accept `vessel` and `route` as required strings. It MUST move a persisted local visit to the route destination and record an authoritative local `VoyageEvent`.

Errors:

- `400 { "error": "invalid-input" }` for missing or non-string fields;
- `403` for a domain-forbidden movement;
- `404` for an unknown route;
- `409` for no active visit, wrong starting port, or a non-local connection.

The successful response MUST be `{ "success": true, "event": VoyageEvent }`.

### 11.5 Player operations

`mine`, `manufacture`, `transfer`, `load`, and `unload` MUST require a positive safe-integer `count`.

- `mine` MUST accept an optional `variety` that equals the configured ore Variety.
- `manufacture` MUST require `recipe: "ore-to-metal"`.
- `transfer` MUST require `variety` to be configured ore or metal and `direction` to be `to-port` or `to-warehouse`.
- `load` and `unload` MUST require `vessel`, a configured variety, and an active local visit possessed by the caller.

Invalid request fields MUST return `400 { "error": "invalid-input" }`. Valid requests rejected by local domain rules MUST return `409` with `OperationResult`. `load` and `unload` MUST return `403 { "error": "forbidden" }` when the vessel has no active visit possessed by the caller or the variety is not locally supported.

Successful `load` and `unload` MUST queue a `CargoOperationEvent` for the Registry.

### 11.6 Policy administration

`POST /local/territory/admin/policy` MUST accept the full Policy object. The server MUST require:

- a `recipes` array with unique nonempty IDs, configured output Varieties, positive output counts, and positive configured ingredient counts;
- a boolean `miningPermitted`;
- nonnegative safe integers for quota, reserve, and limits;
- permits that reference existing recipe IDs;
- `decisions` values of `allow` or `deny`;
- optional `varietyPortPolicy` keyed by absolute HTTP(S) URIs without userinfo, with `allow` or `deny` values.

Invalid policy MUST return `400 { "error": "invalid-input" }` or a `400` `OperationResult` depending on whether validation or domain update rejected it.

`POST /local/territory/admin/admission` MUST accept a partial admission object. Allowed keys are the four admission lists plus `mismatchPolicy`, `reviewMode`, and `publicPorts`. Unknown keys MUST be rejected. Success MUST return the resulting admission policy.

`GET /local/territory/admin/entry-requests` MUST return retained entry-request records. Decision routes MUST apply to the exact request ID and return a decision result containing `requestId`, `accepted`, and any available `reason`, `decision`, `event`, and `decidedAt`.

A terminal decision MUST be returned again without reversal or a second event. An unknown request MUST return `404 { "error": "not-found" }`.

### 11.7 Entry decisions

A policy endpoint approval MAY produce a `BerthingEvent` immediately. A rejection MUST produce an `EntryRejected` event. A Client MUST NOT treat an accepted decision as a completed berth without the corresponding `BerthingEvent`.

## 12. Territory: Simulation Endpoints

The following simulation endpoints are optional. A Territory server MAY implement any of them. If it implements an endpoint, it MUST satisfy the corresponding requirements.

| Method and path | Required permission | Request | Success |
|---|---|---|---|
| `GET /local/territory/info` | none | None | `200` with kind, Actor, IDs, endpoints, production |
| `GET /local/territory/permissions` | player | None | `200 { "<territory-handle>": string[] }` |
| `GET /local/territory/actions?vessel=<URI>` | player | Required query | `200` with `LocalActionDiscovery` |
| `GET /local/territory/state` | player | None | `200` with `SimulationTerritoryState` |
| `POST /local/territory/mine` | player | `{ count, duration? }` | `200 { job: number }` |
| `POST /local/territory/manufacture` | player | `{ count, recipe: "native" | "imported" }` | `200 { job: number }` |
| `POST /local/territory/load` | player | `{ entryRequest, cargo, duration }` | `200 { job: number }` |
| `POST /local/territory/unload` | player | `{ entryRequest, cargo, duration }` | `200 { job: number }` |
| `POST /local/territory/admin/facilities` | administrator | Partial facility sections | `200 { ok: true }` |
| `POST /local/territory/admin/tick` | administrator | No required body; any body ignored | `200` with `SimulationTerritoryState` |
| `POST /local/territory/admin/admission` | administrator | Partial admission object | `200 { admission }` |
| `GET /local/territory/admin/entry-requests` | administrator | None | `200 { requests }` |
| `POST /local/territory/admin/entry-requests/:requestId/approve` | administrator | Optional `{ reason?: string }` | `200` with decision result |
| `POST /local/territory/admin/entry-requests/:requestId/reject` | administrator | Optional `{ reason?: string }` | `200` with decision result |

### 12.1 Permission map

`GET /local/territory/permissions` MUST return `401 { "error": "unauthorized" }` for missing or invalid `player` permission, and `500 { "error": "actor-handle-unavailable" }` if the Territory has no published handle. An authenticated non-administrator MUST receive `200` with an empty role array.

### 12.2 Action discovery

`GET /local/territory/actions` MUST require `player` permission and a vessel query. Administrator permission alone MUST NOT be sufficient.

If the vessel has an active local visit, the server MUST use that visit and MUST require the visit possessor to equal the Player. Otherwise the server MUST fetch the vessel document and MUST require:

- a valid Vessel whose ID equals the requested vessel;
- the Player to equal the vessel's `possessor`;
- the vessel's Registry to pass `trustedRegistry`.

The response state MUST contain the current tick, shared raw and product stock, facility configuration, the active visit and its cargo and handling, and queued production. Actions MUST be previews; ticks and execution MUST revalidate.

Errors:

| Status | Condition |
|---|---|
| `401` | Missing or invalid `player` permission |
| `403` | Administrator-only permission, non-possessor, or Registry not admitted |
| `400` | Missing vessel, or invalid vessel metadata |
| `404` | Vessel metadata returns `404` |
| `502` | Vessel metadata source is unavailable |

### 12.3 Simulation state

`GET /local/territory/state` MUST return the retained `SimulationTerritoryState`, including simulation state, visits, decisions, evidence, admission, and requests. It MUST NOT advance a tick.

### 12.4 Player operations

`mine` MUST accept `count` and optional `duration` as safe integers. `manufacture` MUST accept `count` and `recipe` as `native` or `imported`. Both MUST return a job number; output and completion occur only as ticks advance.

`load` and `unload` MUST accept:

```json
{
  "entryRequest": "<EntryRequest URI>",
  "duration": 1,
  "cargo": {
    "entries": [
      { "variety": "<Variety URI>", "data": {}, "id": "<Item ID>" },
      { "variety": "<Variety URI>", "data": {}, "count": 1 }
    ]
  }
}
```

Each cargo entry MUST be either an Item with a string `id` and implied count one, or a Stack with a positive safe-integer `count`. The Player MUST possess the active visit identified by `entryRequest`; otherwise the route MUST return `403 { "error": "forbidden" }`.

Invalid operation shape MUST return `400 { "error": "invalid-operation-input" }`. Domain scheduling failures MUST be surfaced as `400 { "error": "<message>" }`.

### 12.5 Simulation administration

`POST /local/territory/admin/facilities` MUST accept any subset of:

```json
{
  "mining": { "enabled": true, "capacity": 10 },
  "manufacturing": { "slots": 2, "time": 3 },
  "port": { "capacity": 20, "berths": 2 }
}
```

A supplied section MUST contain all of its fields. `mining.capacity` and `manufacturing.slots`/`time` MUST be positive safe integers; `port.capacity` and `port.berths` MUST be nonnegative safe integers. Invalid input MUST return `400 { "error": "invalid-operation-input" }`. Domain configuration failures MUST be surfaced as `400`.

`POST /local/territory/admin/tick` MUST ignore any request body and MUST advance the simulation by one tick. It MUST return the resulting state. It MAY produce berthing, departure, cargo, or production effects according to the current state.

`POST /local/territory/admin/admission` MUST accept the four admission lists plus `reviewMode`, `manifestPolicy`, and `requireExitEvidence`. Unknown keys MUST be rejected. Invalid input MUST return `400 { "error": "invalid-admission" }`.

`GET /local/territory/admin/entry-requests` MUST return retained entry-request records. Decision routes MUST apply to the exact request ID and return a decision result containing `requestId`, `accepted`, and any available `reason`, `decision`, `event`, and `decidedAt`.

A rejected request MUST produce an `EntryRejected` event. An approved request MAY remain pending until a later tick produces the `BerthingEvent`; the decision response MUST NOT by itself prove berthing. Terminal decisions MUST be returned again without reversal.

## 13. Discovery

### 13.1 Discovery payloads

A Territory server that provides `/local/territory/info` MUST return at least `kind`, `actor`, `ids`, and `endpoints`, and MAY include `production`:

```json
{
  "kind": "territory",
  "actor": "<Territory Actor URI>",
  "ids": {},
  "endpoints": [],
  "production": {}
}
```

A server that combines Home, Registry, and Repository roles MAY advertise its combined service at `/local/info`. The shape of that advertisement is implementation-defined; for example:

```json
{
  "kind": "combined",
  "actor": "<Actor ID map>",
  "ids": {},
  "players": {},
  "vessels": {},
  "endpoints": []
}
```

A Home server MUST expose `/local/home/endpoints` with at least:

```json
{
  "endpoints": [
    { "method": "GET", "path": "/local/home/vessels", "permission": "player" }
  ]
}
```

### 13.2 Advisory nature

An endpoint advertisement is advisory. A server MUST NOT require a Client to call a discovery route before any other route. A Client MUST NOT require an advertisement before calling a route. A Client MUST NOT treat an omitted route as unavailable or an advertised permission label as a permission decision.

## 14. Client Conformance

A conforming Client MUST follow the route definitions, required permissions, and response semantics in this convention. It MAY use additional implementation-defined routes, but those routes are outside this convention.

## 15. Server Conformance

A server that implements the Home role MUST implement the routes in Section 8.

A server that implements the Registry role MUST implement the routes in Section 9.

A server that implements the Repository role MUST implement the routes in Section 10.

A server that implements the Territory role MUST satisfy the requirements in Sections 11 and 12 for each endpoint it provides. It MAY implement any subset of those optional endpoints.

A conforming server MUST enforce the required-permission rules in Section 5, the state and completion semantics in Section 6, and the route-specific requirements for every role and endpoint it provides.

A conforming Client MUST satisfy the requirements in Section 14.

A server MAY implement additional routes, but those routes are outside this convention. A server MUST NOT require a Client to use an undocumented route to obtain a result promised by this convention.

## 16. Security Considerations

The Basic API relies on server-defined authentication. Possession of valid authentication for a Player allows its holder to act as that Player at the server that accepted it. Administrator permission allows administrative operations at that server. A Client MUST protect authentication material and MUST NOT expose it to untrusted components.

A server MUST protect authentication material and MUST NOT include it in public responses. Clients and servers SHOULD redact authentication material and passwords from logs and diagnostics.

A Home compromise can break authentication for its accounts. A target or operator compromise can break that target's permission policy and data. TLS is required for any non-loopback deployment that carries authentication material.

The Basic API proves possession of whatever authentication the server requires. It does not prove human presence, intent, or independent permission beyond the configured administrator model.

## 17. References

- [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
- [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
- [RFC8259] Bray, T., "The JavaScript Object Notation (JSON) Data Interchange Format".
- FCTP protocol specification (`protocol.txt`).
