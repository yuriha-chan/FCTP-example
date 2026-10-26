# Territory B federation adapter handoff

## Scope and files

- `apps/territory-sim/src/territory.ts`: B-local federation adapter over the existing independent `domain.ts` simulation model.
- `tests/sim-territory.test.ts`: signed real-Actor envelope integration scenarios using a host adapter.
- This checkpoint adds no HTTP resource, application factory, UI, policy-domain imports, or root/client changes.

## Exported API

- `installSimulationTerritory(host, options)` installs EntryRequest and DepartureRequest handlers and returns a `SimulationTerritory` adapter.
- Adapter operations: `state()`, `mine(count, duration?)`, `manufacture('native' | 'imported', count)`, `handle(entryRequestId, 'load' | 'unload', cargo, duration)`, `tick()`, `configureMining(enabled, capacity)`, `configureManufacturing(slots, time)`, and `configureFacilities({ mining?, manufacturing?, port? })`.
- `simulationExpectedIssuer(sender, object, knownRegistry?)` is the exported host `resolveExpectedIssuer` helper. For EntryRequest, it accepts only the embedded vessel Registry matching the sender. For DepartureRequest, the caller supplies the visit's recorded Registry.
- `SimulationTerritoryOptions` requires the local port/route, domain `SimulationConfig` (including `commodityMasses`), accepted Registry URIs, and accepted prior Territory URIs. It supports local manifest policy (`request`, `evidence`, or `reject-difference`), optional evidence requirement, fetcher/Registry inbox resolver, territory Actor name, epoch, and tick duration.

## Behavior and assumptions

- All adapter mutations, including evidence retrieval and signing, run through a single local async queue. Each durable domain mutation and its outgoing messages use `FctpServer.commit` together.
- Inbound EntryRequest and DepartureRequest payloads are runtime-validated and gated by cryptographic proof, key attribution, expected issuer, sender/request Registry linkage, destination/port/route linkage, and local B acceptance settings. Invalid publisher envelopes are ignored without business state or EntryRejected. Business admission rejects emit EntryRejected; malformed model payloads fail the handler.
- Entry visits retain the original request, Registry, possessor, route, decision, and evidence metadata. Only accepted non-exited visits block admission; a rejected request does not reserve the vessel. Entry destination must match the configured local territory, port, and route. After exit, a later request gets a distinct internal simulation vessel identity while preserving the protocol vessel URI.
- A successful admission creates a pending vessel. Berthing is emitted only on a tick that grants a berth; timestamps derive from `epoch + tick * tickDurationMs` (defaults: 2000-01-01 UTC and 60 seconds per tick).
- Evidence uses `resolveExitEvidence` for factual signature/attribution/issuer and request binding. B separately applies accepted prior Territory and manifest policy. `compareCargo` determines cargo differences without treating them as trust.
- Handling reserves work through the existing B domain; CargoOperationEvent is queued only for completed effects. Native and imported manufacturing remain calls into the independent B domain. A departure request may be recorded for an active berthed vessel while handling remains pending; departure and ExitEvent wait until handling jobs for the internal simulation vessel are complete.
- Visit and request IDs, decisions, accepted evidence, and the complete simulation state persist under `domain.simulationTerritory`.

## Verification

| Command | Result |
| --- | --- |
| `npx tsc -b apps/territory-sim/tsconfig.json --pretty false` | Passed. App source included. |
| `npx tsx --test tests/sim-territory.test.ts` | Passed, 4 tests. Covers signed inbound Activity envelopes, delayed berthing, completed handling, independent verification of the complete nested ExitEvent after JSON roundtrip, rejected admission retry, wrong local port/route rejection, invalid-signature no-business-state behavior, pending handling departure deferral, native mining/manufacturing, imported-product unload/reprocessing, vessel return after exit, and capacity constraints. Test source included. |
| `npx eslint apps/territory-sim/src/territory.ts tests/sim-territory.test.ts` | Passed. App and test source included. |
| `npx tsc -p tests/tsconfig.json --pretty false` | Blocked by pre-existing `tests/sim-domain.test.ts:136` TS7053 string-indexing error. This is outside the owned paths and was not changed. |

No shared contracts or out-of-scope files were changed. The full signed ExitEvent context remains embedded in the outgoing Activity and independently verifies after JSON serialization and parsing.
