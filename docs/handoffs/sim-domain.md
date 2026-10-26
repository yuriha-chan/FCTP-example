# Territory B domain handoff

## Scope and files

- `apps/territory-sim/src/domain.ts`: independent serializable discrete-tick simulation domain.
- `tests/sim-domain.test.ts`: focused domain scenarios.
- No HTTP, federation, policy-domain, or shared production engine was added. Local inventory uses structured commodity buckets that retain Item IDs, quantity kind, and Stack data; CargoManifest is used at vessel admission and emitted operation boundaries.

## Exported API

- `SimulationConfig`, `SimulationState`, `VesselCargo`, `VesselState`, `ProductionJob`, `HandlingJob`, and `CompletedEffect` describe the local serializable state and result contracts.
- `createSimulationState(config)` initializes state and validates exact nonempty distinct commodity IDs, a positive finite `commodityMasses` entry per configured commodity, and capacities. Config requires IDs for `ore`, `nativeMetal`, `importedMetal`, and `refinedProduct`; quantities and durations use positive/nonnegative integer tick units.
- `configureMining(state, enabled, capacity)`, `configureManufacturing(state, slots, time)`, and `configurePort(state, capacity, berths)` apply facility/port configuration changes and append audit records.
- `startMining(state, count, duration?)` reserves finite deposit and mining capacity immediately. It returns a job ID; ore enters `rawStock` only when ticks complete.
- `startManufacturing(state, 'native' | 'imported', count)` consumes reserved inputs immediately. Native recipe: ore → native metal. Imported recipe: imported metal → refined product. The configured manufacturing duration is captured at start; output enters `productStock` only at completion.
- `admitVessel(state, id, capacity, cargo?)` creates a pending vessel and preserves Item IDs and quantity data. Capacity is vessel mass; it is computed from configured per-commodity masses and admission rejects unknown masses or over-capacity cargo.
- `scheduleHandling(state, vesselId, 'load' | 'unload', cargo, duration)` schedules timed handling. Loads reserve matching raw/product warehouse stock globally across vessels and reserve vessel mass. This allows unchanged evidence cargo to be reloaded. Unloads reserve exact vessel cargo and local warehouse slots, and place completed cargo in raw inventory, including imported metal for reprocessing. Duplicate quantities within a request cannot spend stock twice.
- `departVessel(state, vesselId)` rejects departure while handling is pending.

State is plain JSON-serializable data. `VesselCargo` keeps the compatible `commodity` and `count` fields and adds optional `quantityKind`, `id`, and `data`; absent kind/data on existing `scheduleHandling` callers means an empty-data Stack. Distinct data-bearing Stacks and Items are not merged. Item identities and data survive admission, handling, emitted CargoManifest effects, and unload. Local production accepts only homogeneous empty-data Stack ingredients and explicitly rejects Item or nonempty-data ingredients before consuming them. Manufacture transforms accepted ingredient Stacks to local output Stacks with empty data; this is local recipe policy, not protocol invalidity. Port capacity is a local quantity-slot limit, separate from vessel mass capacity; pending mining/manufacturing outputs and unloads reserve warehouse slots before completion, and `configurePort` rejects capacity reductions below occupied and reserved slots.

## Checks

- `npx tsx --test tests/sim-domain.test.ts`: passed, 8 tests, including global and within-request reservation, mass-based capacity, Item/data preservation, unsupported production input rejection, and reserved warehouse capacity.
- `npx eslint apps/territory-sim/src/domain.ts tests/sim-domain.test.ts`: passed (exit 0).
- `npx tsc -b apps/territory-sim/tsconfig.json --pretty false`: passed (exit 0).

## Integration boundary

The next unit can map returned `CompletedEffect` records to actual Territory events. Event IDs, timestamps, persistence, HTTP endpoints, and federation delivery are intentionally not part of this domain API. Completed operation effects represent Items with IDs and data and Stacks with their original count and data, allowing accepted evidence cargo to remain faithful through exit publication.
