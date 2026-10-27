# Policy audit attribution and Variety port permit

## Scope

Completed unit 2: thread acting Actors through Territory A operations and add a local port permit keyed by canonical FCTP Variety URI. No FCTP object, shared package, B, client, Authority, or protocol semantic was changed.

## Changed files

- `apps/territory-policy/src/domain.ts`
- `apps/territory-policy/src/territory.ts`
- `apps/territory-policy/src/app.ts`
- `tests/policy-domain.test.ts`
- `tests/policy-territory.test.ts`
- `tests/policy-app.test.ts`
- `tests/policy-actions.test.ts`
- `docs/handoffs/policy-audit-variety.md`
- `docs/memos/policy-audit-variety.json`

`apps/territory-policy/src/actions.ts` was reviewed and left unchanged; its previews continue to call the existing domain signatures with the default `system` actor and operate only on clones.

## Exported API changes

- `Policy.varietyPortPolicy?: Record<string, 'allow' | 'deny'>`.
- `mineOre`, `manufacture`, `transferWarehouseToPort`, `transferPortToWarehouse`, `loadCargo`, and `unloadCargo` accept an optional trailing `actor` defaulting to `system`.
- `prepareVessel(state, vesselId, capacity, cargo?, actor?)` and `exitVessel(state, vesselId, actor?)` accept an optional trailing `actor` defaulting to `system`.
- Adapter operations `mine`, `manufacture`, `transferWarehouseToPort`, `transferPortToWarehouse`, `load`, and `unload` accept an optional trailing `actor` and pass it to the domain.
- App `/local/mine`, `/local/manufacture`, `/local/transfer`, `/local/load`, and `/local/unload` pass the authenticated Player Actor URI.
- Entry handling passes the verified Registry sender to `prepareVessel`; departure handling passes the verified Registry sender to `exitVessel`. No Player is fabricated for these Registry request paths.
- The app policy validator accepts an optional `varietyPortPolicy` object whose keys are safe absolute `http`/`https` URIs without credentials and whose values are `allow` or `deny`.

## Behavior

### Audit attribution

- Accepted and rejected Player-initiated operations now record the acting Player URI in `TerritoryState.audit`.
- Internal calls and action-discovery previews retain `system` by default. Previews remain read-only and do not persist audit entries.
- Cargo authorization is unchanged: `/local/load` and `/local/unload` still require the authenticated Player to be the active visit possessor before the domain runs.

### Local Variety port permit

- `varietyPortPolicy` is a local A administrative permit policy, not an FCTP protocol field and not evidence of production execution.
- Missing key means `allow`; an explicit `allow` is also accepted.
- `deny` rejects `load` and `unload` of that exact canonical Variety URI before any port-inventory or vessel-manifest mutation, and records a rejected audit entry attributed to the acting Player.
- The permit does not rewrite, clone, register, or otherwise alter a Variety object. B has no equivalent mechanism in this unit; that absence is an implementation difference, not a protocol failure.

## Verification

Commands were run sequentially from `/app`:

| Command | Result |
| --- | --- |
| `npm run build` | Passed (TypeScript project builds, client compilation, browser bundle). |
| `npm run typecheck:tests` | Passed (test sources and client sources). |
| `npx tsx --test tests/policy-domain.test.ts` | Passed: 8 tests, 8 passed, 0 failed. |
| `npx tsx --test tests/policy-territory.test.ts` | Passed: 2 tests, 2 passed, 0 failed. |
| `npx tsx --test tests/policy-app.test.ts` | Passed: 1 test, 1 passed, 0 failed. |
| `npx tsx --test tests/policy-actions.test.ts` | Passed: 3 tests, 3 passed, 0 failed. |
| `npx eslint apps/territory-policy/src/domain.ts apps/territory-policy/src/territory.ts apps/territory-policy/src/app.ts apps/territory-policy/src/actions.ts tests/policy-domain.test.ts tests/policy-territory.test.ts tests/policy-app.test.ts tests/policy-actions.test.ts` | Passed with no output. |

Coverage added: Player attribution for accepted and rejected domain operations; Registry attribution for entry `prepare-vessel` and departure `exit-vessel`; adapter-level Player attribution for `load`; HTTP-level accepted and rejected Player audit attribution; deny and allow load/unload with the canonical metal URI and unchanged inventories/manifests; missing entry as allow; malformed absolute-URI keys, invalid decisions, and non-record policy input rejected by the app; read-only preview behavior with a denied canonical Variety.

## Boundaries and limits

- No broad gate was run and no commit was created.
- No browser/UI acceptance was performed.
- The permit is local policy only; it does not claim that a canonical Variety or any FCTP object changed, and it does not claim production execution.
- `removeVessel` and direct `changePolicy` audit behavior was left as established; they were outside the assigned actor list.
- A cargo-operation request without an active visit still returns an authorization-level failure without a domain audit entry; this preserves established adapter behavior.
