# Delivery outage acceptance handoff

## Scope and behavior

- `FctpServer.resolveRecipientInbox(actorId)` is the shared outbound routing API. It resolves via the server's configured fetcher and `@fctp/identity` Actor resolution, validates the Actor runtime model and exact requested ID, then persists the public Actor and absolute inbox URI in `remoteActors`.
- Cached routing is used without a network refresh for later operations, so an outage does not block domain/outbox commit for known recipients. This is the local refresh choice; there is no TTL or automatic refresh. Unknown recipients must resolve online once.
- Policy and Simulation use the shared resolver. Simulation retains its explicit `registryInbox` injection override. No trust, evidence, or game policy is changed.
- Inbox recovery retains invalid declarations, dedup hashes, and original Activity content.
- The outage integration test uses actual Authority and Policy factories, loopback HTTP, enrolled tokens, signed Activities, and persistent JSON stores/keys. Registry inbox processing is explicitly pumped after delivery; duplicate posts then yield zero additional inbox processing. Authority restarts only after its prior instance closes.

## Owned files and exports

- `packages/server-base/src/server.ts`: exports `FctpServer.resolveRecipientInbox(actorId: URI): Promise<URI>` through the existing class API.
- `packages/server-base/src/store.ts`: durable `remoteActors` routing cache.
- `apps/territory-policy/src/territory.ts`, `apps/territory-sim/src/territory.ts`: shared recipient routing only.
- `tests/delivery-outage.test.ts`: corrected processing/restart sequencing.
- This handoff and `docs/memos/delivery-outage.json`.

## Verification

- `npm run build && npm run typecheck:tests` — passed; application and test sources included.
- `npx tsx --test tests/delivery-outage.test.ts tests/policy-territory.test.ts tests/sim-territory.test.ts` — passed, 7 tests.
- `npx eslint packages/server-base/src/server.ts packages/server-base/src/store.ts apps/territory-policy/src/territory.ts apps/territory-sim/src/territory.ts tests/delivery-outage.test.ts` — passed.
- Registry handler acceptance independently exercises cryptographic verification, key attribution, and expected-issuer checks. Two duplicate POSTs produced `processInbox() === 0`. Territory restart retained both route cache and enrolled token state.

## Acceptance boundary

This checkpoint covers shared remote Actor routing and durable retry for one completed Policy load. It does not establish broader outage behavior.
