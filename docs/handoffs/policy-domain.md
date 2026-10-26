# Territory A policy-domain handoff

## Scope

Implemented the serializable, pure local economic ledger checkpoint for Territory A. No HTTP routes, administrator authentication, persistence integration, federation flow, or shared production engine is included.

## Changed files

- `apps/territory-policy/src/domain.ts`
- `tests/policy-domain.test.ts`
- `docs/handoffs/policy-domain.md`

## Exported API

- `Commodity`, `Recipe`, `Policy`, `VesselCargo`, `AuditEntry`, `TerritoryState`, and `OperationResult` describe JSON-serializable policy and economic state.
- `createTerritoryState` initializes cloned policy and configured commodities with independent raw inventory, production reservations, port inventory, vessel cargo, and audit log.
- `changePolicy(state, policy, actor)` validates basic policy values, changes policy explicitly, and records the administrator actor label and policy in the audit log.
- `mineOre`, `manufacture`, `transferWarehouseToPort`, `transferPortToWarehouse`, `prepareVessel`, `removeVessel`, `loadCargo`, and `unloadCargo` return new state values. Immediate mining/manufacture has no production reservations. Rejections leave economic inventories and vessel cargo unchanged while recording a rejection in the audit log. `mineOre` only accepts a configured commodity whose Variety declares a `production` entry with `type: 'mine'`.
- `territoryAProduction` exports sample Ore/Metal Variety records, an Ore-to-Metal local recipe (2 Ore → 1 Metal), and corresponding FCTP `Production` descriptions. Both production descriptions use duration 0 for the local immediate-execution convention.

FCTP `CargoManifest` is used at the cargo boundary and as each vessel's serializable manifest. `prepareVessel` validates admitted manifests with protocol `validateModel(..., 'CargoManifest')`, rejects duplicate Item IDs, and checks configured variety mass against vessel capacity; unknown varieties are rejected. Item identity, Stack data, manifest-level extension fields, and entry extensions are cloned through admission and load/unload operations. Local warehouse/port inventory and production remain per-variety counts: those APIs cannot represent Items or nonempty Stack data. `loadCargo` creates/merges only empty-data stacks; `unloadCargo` consumes only empty-data stacks and rejects when that eligible quantity is insufficient. `removeVessel` rejects nonempty manifests so it cannot silently discard cargo. There is no separate exit API in this domain checkpoint; departure integration must carry the vessel's manifest forward.

## Checks

| Command | Result |
| --- | --- |
| `npx tsx --test tests/policy-domain.test.ts` | Passed: 5 tests, 5 passed, 0 failed. |
| `npx eslint apps/territory-policy/src/domain.ts tests/policy-domain.test.ts` | Passed (exit 0). |

No TypeScript check was run: the supervisor handoff states that Territory app tsconfig integration is still pending, and the requested focused commands were the test and ESLint commands above.

## Findings and checkpoint boundary

- Tests cover mining → manufacture → port → load → unload conservation, policy permit effects, quota/reserve limits, insufficient ingredients/stock, port limit, vessel mass capacity, Item/nonempty Stack preservation, cargo validation and duplicate Item ID rejection, and manufactured-variety mining rejection.
- `productionReservations` is explicit and empty for immediate operations.
- Rejection audit entries are state changes to the audit trail only; no economic quantity or cargo mutation is applied on a rejected operation.
- `Policy.decisions` is an explicit extensible decision map for subsequent entry/handling policy work; this unit enforces mining, manufacturing, stock, and cargo rules directly.
- Count-based production and warehouse/port transfer APIs intentionally support only variety quantities and cannot consume arbitrary manifest Items or nonempty Stack data as ingredients. Production recipe conversion is explicitly restricted to rawInventory counts; admitted vessel cargo stays in its manifest. `removeVessel` is not an exit implementation and rejects cargo-bearing vessels; downstream lifecycle code must preserve and forward the accepted manifest.
- No blockers observed. Stop at the ledger checkpoint; subsequent lifecycle/admin HTTP work remains outside this unit.
