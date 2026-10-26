# Policy application factory handoff

## Scope and exported API

`createPolicyApp(options)` composes `createHost` with `installPolicyTerritory` and returns `{ host, territory, ids }`. Its options are `origin`, `storeFile`, `authorityOrigin`, `peerOrigin`, `adminSecret`, and optional `keyFile`/`fetcher`. The IDs include the Territory Actor, two ports, two routes, one area URI, a MapDescriptor, local ore/metal Varieties, and corresponding Assets.

The factory publishes linked JSON-LD resources, top-level Port `listings` links, Area objects in Actor `resources.areas`, and a map descriptor using `https://fctp.example/formats/ascii`. Map and Asset text endpoints return `text/plain; charset=utf-8`. Asset creator is the configured authority Player URI. Public port and listing resource visibility follows persisted `admission.publicPorts` at startup and after admission updates; other ports return 401 without credentials and 403 for authenticated Players denied by policy. The public-port policy resource is refreshed with the same updates.

The local API keeps Player diplomatic-token authentication separate from administrator authentication. Cargo operations compare the authenticated Player to the possessor retained from the verified, accepted original EntryRequest in the persisted visit; they do not refetch an unsigned EntryRequest. The only adapter change is the persisted visit's `possessor` field.

Policy and admission request validation checks nested recipe, quantity, variety, limit, decision, and URI values before mutation. Operation variety membership is restricted to the configured local ore and metal URIs.

## Focused test coverage

`tests/policy-app.test.ts` exercises Home-signed token delivery and authentication, public/private ports and listings including admission changes, invalid commodity and nested policy input, administrator separation, production state, Actor Area resources, exact map format/media type, and Asset creator/text response.

## Repair checkpoint

- Changed `apps/territory-policy/src/app.ts`, `apps/territory-policy/src/territory.ts`, `tests/policy-app.test.ts`, and this handoff.
- Exported app API remains `createPolicyApp` and its existing options/return structure; `VesselVisit` now persists `possessor` sourced from the accepted inbound EntryRequest.
- `npx eslint apps/territory-policy/src/app.ts apps/territory-policy/src/territory.ts tests/policy-app.test.ts` passed with no output. Integrated build, test typecheck, and runtime tests remain pending; no root gates were run while the peer Territory repair is in progress.
