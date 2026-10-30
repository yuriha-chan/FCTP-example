# Local HTTP API reference

All routes below are local demo APIs under `/local/`, not standardized FCTP endpoints. JSON bodies are objects. Use `Authorization: Bearer <credential>`; administrative credentials are separate per service from the Player's native token and Territory-specific diplomatic bearer tokens. See [the client walkthrough](client-walkthrough.md) for form workflows.

## Authority (port 4100)

`GET /local/info` and `GET /local/home/endpoints` are public discovery routes. `GET /local/registry/state` requires the authority admin credential and returns Registry state including vessel, requests, events, cargo and ExitEvent references.

### Player authoring

The experimental authoring routes use the authenticated Player's native token (`Authorization: Bearer <nativeToken>`), never a caller-supplied Player, creator, holder, object ID, or administrator credential. Responses are `Cache-Control: no-store`. `GET /local/authoring` returns `{ actor, assets, varieties, grants }` for only that Player. `POST /local/authoring/assets` accepts `{ name: string, text: string }` and returns `201 { asset, activity }`. `name` must be nonempty; `text` is stored as inert text and exposed through the Asset's single `text/plain` media URI.

`POST /local/authoring/varieties` accepts `{ name: string, mass: number, version: string, asset?: URI, production?: Production[] }` and returns `201 { variety, activity, grant? }`. Name and version must be nonempty, mass must be finite and positive (fractional values are accepted), and production defaults to `[]` and is validated against the protocol runtime `Production` shape while retaining extension fields. If `asset` is supplied, it must be an Asset authored and held by this same Player; success creates a corresponding `AssetGrant` for the Player and Variety in the same commit, returned as `grant`.

Missing or invalid native authentication returns `401`; malformed JSON, non-object bodies, invalid fields, and unsupported top-level keys return `400` without authoring mutation. A reference to an Asset not owned by the authenticated Player returns `403` without mutation. Signing and persistence failures propagate as server failures. The Player Actor exposes a public `creations` link to `/objects/players/<name>/creations`, an OrderedCollection of that Player's published Assets, Varieties, and AssetGrants. The objects, collection, text media, and public Outbox are public resources; native-auth catalog scoping does not make published output secret. Local publication records signed Create Activities in the Player Outbox with an empty recipient list and does not enqueue delivery. No remote subscriber delivery is implied. Optional Production is descriptive data: it does not install a Territory rule or generate cargo.

The rendered client exposes Asset text controls from a loaded public `creations` collection, so a non-owner can read published text. Each control attempts the public media GET without credentials first; only a `401` or `403` with a native token falls back to the Actor-scoped authenticated read. `404` and other failures remain visible.

| Route | Credential | Request | Response |
|---|---|---|---|
| `POST /local/home/issue` | Authority admin | Optional `{ "actor": "<Player URI>" }` | `200 { actor, nativeToken }` |
| `POST /local/home/rotate` | Authority admin | Optional `{ "actor": "<Player URI>" }` | `200 { actor, nativeToken }` |
| `POST /local/home/digest-request` | Authority admin | `{ "resourceActor": "<Territory Actor URI>" }` | `202 { "status": "queued" }` |
| `POST /local/home/revoke` | Authority admin | `{ "resourceActor": "<Territory Actor URI>" }` | `202 { "status": "queued" }` |
| `GET /local/home/proxy?uri=<URI>&resourceActor=<Actor URI>` | Player native token | Query parameters | `200` resource JSON or upstream authorization/not-found status |
| `POST /local/registry/entry` | Authority admin | `{ territory, port, route, cargo? }`; cargo is optional `CargoManifest` | `202` created `EntryRequest` |
| `POST /local/registry/departure` | Authority admin | `{ territory, port, route? }` | `202` created `DepartureRequest` |
| `POST /local/registry/adoption` | Authority admin | `{ "adoption": boolean }` | `200` empty response |

`POST /local/registry/entry` and departure validate required string IDs; the Registry resolves the destination Actor/Inbox and persists the request with its outgoing delivery. Omitting cargo uses current Registry cargo. The initial demo vessel is `/objects/vessels/demo`.

## Territory A — policy (port 4101)

`GET /local/info` is public and returns `{ kind, actor, ids, endpoints, production }`. `GET /local/state` requires an enrolled Player diplomatic token or A admin credential and returns `{ state, admission, decisions }`.

| Route | Credential | Request | Response |
|---|---|---|---|
| `POST /local/mine` | Player diplomatic token | `{ count, variety? }`; optional variety must be A ore | `200` operation result or `409` domain rejection |
| `POST /local/manufacture` | Player diplomatic token | `{ count, recipe: "ore-to-metal" }` | `200` result or `409` domain rejection |
| `POST /local/transfer` | Player diplomatic token | `{ direction: "to-port" | "to-warehouse", variety, count }` | `200` result or `409` domain rejection |
| `POST /local/load`, `/local/unload` | Player diplomatic token who possesses the active visit | `{ vessel, variety, count }` | `200` result or `409` domain rejection |
| `POST /local/admin/policy` | A admin credential | Persisted policy object with mining permission/quota/reserve, recipe/permits, limits, optional `varietyPortPolicy` and decisions | `200` update result; `400` invalid policy |
| `POST /local/admin/admission` | A admin credential | Partial admission object; supported fields include `registryAcceptance`, `territoryAcceptance`, `publicPorts`, `mismatchPolicy` | `200 { admission }`; `400` invalid input |

Player-initiated A mine, manufacture, transfer, load, and unload operations record the authenticated Player URI in local audit entries. Registry entry `prepare-vessel` and departure `exit-vessel` record the verified Registry sender; internal and action-discovery preview operations default to `system`. Attribution does not change authorization.

`varietyPortPolicy` is an optional local A permit map keyed by absolute `http` or `https` canonical Variety URIs without credentials. A missing entry means allow; `deny` rejects `load` or `unload` of that exact variety before port inventory or vessel manifest changes, with an attributed rejection. The permit does not create, modify, or register a Variety object, is not an FCTP field, and has no B equivalent. Policy validation returns `400` for malformed keys or decisions other than `allow` or `deny`.

Player credentials identify an enrolled Player; load/unload additionally require that Player to match the active visit possessor. An administrator credential alone cannot operate cargo. Invalid credentials return `401`; authenticated but unauthorized cargo access returns `403`; unknown `/local/` paths return JSON `404`. Invalid JSON/operation fields return `400`; valid operation requests rejected by local domain conditions may return `409`.

## Territory B — simulation (port 4102)

`GET /local/info` is public. `GET /local/state` accepts an enrolled Player diplomatic token or B admin credential and returns simulation state including ticks, jobs, inventories, vessels and visits.

| Route | Credential | Request | Response |
|---|---|---|---|
| `POST /local/mine` | Player diplomatic token | `{ count, duration? }`, duration in local ticks | `200 { job }` |
| `POST /local/manufacture` | Player diplomatic token | `{ count, recipe: "native" | "imported" }` | `200 { job }` |
| `POST /local/load`, `/local/unload` | Player diplomatic token matching visit possessor | `{ entryRequest, cargo: { entries: [...] }, duration }` | `200 { job }` |
| `POST /local/admin/facilities` | B admin credential | Partial validated facility sections: `mining`, `manufacturing`, `port` | `200 { ok: true }` |
| `POST /local/admin/tick` | B admin credential | `{}` (body is read for POST) | `200` tick result |

Cargo entries preserve Item (`{ id, variety, data }`) versus Stack (`{ variety, count, data }`) identity. Jobs reserve applicable inputs/capacity and complete only as ticks advance. Valid credentials without permission return `403`; absent/invalid credentials return `401`; invalid bodies return `400`. Unknown paths return `404`. Resource retrieval may return `406` for an unsupported requested representation/format; the browser currently supports the local ASCII map format and text assets. Protected resource requests also use standard `401` unauthenticated, `403` denied and `404` missing-resource responses.

## Browser and service setup

The launcher serves the client at `http://127.0.0.1:4103`; default services are loopback HTTP on ports 4100–4102. Admin service secrets default to `demo-authority-admin`, `demo-policy-admin`, and `demo-sim-admin`; environment overrides are `DEMO_AUTHORITY_ADMIN_SECRET`, `DEMO_POLICY_ADMIN_SECRET`, and `DEMO_SIM_ADMIN_SECRET`. `FCTP_DATA_DIR` changes the default persistent `.fctp-data` directory, including `client.store.json` and the world stores. The demo provisions two Players and a governor account with development passwords documented in the [browser harness guide](browser-harness.md#start-the-local-demo); passwords are entered through the client application or harness login and are not part of public configuration.
