# Client presentation health handoff

## Findings

- A full `/local/state` returns top-level `visits` beside `state`; administrator presentation now enumerates those visits instead of only looking inside `state`.
- B persisted visits link to simulation vessels through `simulationVessel`. Scoped presentation selects the latest active visit (or latest visit if none is active), joins its actual simulation status/cargo and handling jobs, and reports exited visits as departed. Handling arrays render their item quantities in both scoped visits and full simulation state.
- Quantities without `count` but with an Item `id` display a count of one. URI decoding falls back only for `URIError`, rethrowing other exceptions.
- Production location metadata preserves the Area's complete `id`, `name`, and `territory` values.
- Existing verification, Registry, stock identity, and descriptive Production presentation coverage remains in place.

## Changed paths

- `apps/client/src/presentation.ts`
- `tests/client-presentation.test.ts`
- `docs/handoffs/client-presentation-health.md`

## Verification

- `npx tsx --test tests/client-presentation.test.ts` — passed, 8/8 tests.
- Type checking, ESLint, and broader mechanical verification are pending. Per assignment, only the focused test was run; no build or full test gate was run.

## Open semantic questions

- None identified. Fixtures use the protocol Area shape (`id`, `name`, and `territory`); Production remains descriptive.
