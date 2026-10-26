# Runnable application composition contract

## Purpose and boundaries

Compose existing generic hosts and independent Territory adapters. This is a local demo interface, not FCTP. Do not add another hosting framework or economic model. All source input files remain authoritative and unchanged.

## Factory interface

- A: `apps/territory-policy/src/app.ts` exports `createPolicyApp(options)`.
- B: `apps/territory-sim/src/app.ts` exports `createSimulationApp(options)`.
- Each accepts `origin`, `storeFile`, optional `keyFile`, `authorityOrigin`, `peerOrigin`, `adminSecret`, optional `fetcher`. Origins are fixed before listen so identifiers match real listener ports. Test callers allocate free ports before creating apps.
- Return `{ host, territory, ids }`. `ids` contains `actor`, `ports`, `routes`, `areas`, `map`, `varieties` and `assets`; `varieties` names A `ore`/`metal`, B `ore`/`metal`/`refined`, and B `importedMetal` pointing to A's metal URI.
- Host Actor name is `territory`. Actor ID is `${origin}/actors/territory`. Registry/Home/Player IDs derive from `${authorityOrigin}/actors/{registry,home,player}`. Demo vessel ID is `${authorityOrigin}/objects/vessels/demo`.
- Commodity URIs are `${origin}/objects/varieties/{ore,metal,refined}`. A uses ore→metal; B uses its own ore→metal plus A metal→B refined. Do not replace imported A Variety identity with a B URI.
- Factories register resources and local routes; callers own `listen`, worker scheduling and `close`. Factories do not start hidden timers.

## Resources

- Publish Actor resources links for Collection ports/routes, Areas, MapDescriptor. Two small A ports, at least one B port, geographic Boundaries and routes, Listings, text Assets, and Variety/Production descriptions are real GET resources under `/objects/`.
- Each server has a local approach route; route references must point to published endpoints. Resource shape matches protocol exactly, including `creator` arrays and `representations`.
- Maps use explicit MVP format `https://fctp.example/formats/ascii`, with `role: "map"` text resource. Plain-text route uses correct media type; descriptor remains JSON-LD.
- Publish capabilities for actually supported profiles. No unsupported complete-profile claim.
- Protect at least one resource using diplomatic tokens via existing server auth; expose 401 and authenticated denial 403. A's public-port policy affects access. Resource authorization is separate from authentication; administrative credentials are not resource tokens.

## Local demo routes

- `GET /local/info` is public, returns `kind: "policy" | "simulation"`, `actor`, `ids`, local endpoint descriptions, and production correspondence. Do not return secrets.
- `GET /local/state` requires a valid enrolled Player diplomatic token or local administrator credential, returns domain state and decisions with no tokens/private keys.
- `POST /local/mine` accepts `{count}`; A may additionally accept `{variety}`; B `{duration}` is local tick count.
- `POST /local/manufacture` accepts `{count}` plus A `{recipe}` or B `{recipe: "native" | "imported"}`.
- A `POST /local/transfer` accepts `{direction: "to-port" | "to-warehouse", variety, count}`.
- `POST /local/load` and `/local/unload`: A `{vessel,variety,count}`, B `{entryRequest,cargo,duration}`. Require valid Player diplomatic token matching active visit possessor; local administrator credential alone must not authorize Player cargo operations.
- A administrator routes `/local/admin/policy` and `/local/admin/admission`; B `/local/admin/facilities` and `/local/admin/tick`. Administrator authentication uses `Authorization: Bearer <adminSecret>` with separate server-local checks; these are not diplomatic tokens. A administrator authority modifies policy; B authority modifies facilities/time.
- Player mining/manufacture/transfer requires valid enrolled Player token. Admin alone may inspect/configure, not impersonate vessel possessor. Return 401 invalid credentials, 403 authenticated-but-not-permitted, 400 invalid operation input; domain rejection can return 409. Bound JSON body size and validate local inputs.
- Enroll configured Player→Home explicitly. Expected issuer resolver returns enrolled Home for structural TokenDigest/Revoke; for other messages use each adapter's established expected-issuer helper and persisted visits. Do not return sender blindly for unknown types.
- Use existing server CORS, including standard Authorization header. No secrets in `/local/info`, resource documents, error messages, logs or acceptance artifacts.

## Testing and ownership

- Each factory unit owns its app.ts, focused application test, and app handoff only. Do not alter shared host/domain contracts silently.
- Focused tests use actual HTTP resources, Home-signed digest delivery, real proofs, authentication failures, administrator restrictions, and a local production operation. No UI tests.
- Later composition provides a single command launching authority, A/B and browser static client. Later cross-Territory tests exercise full economic circulation.
