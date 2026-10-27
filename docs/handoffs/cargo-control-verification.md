# Cargo-control repair verification

## Scope

Mechanical verification of the cargo-control repair in the working tree. Changed files under review:

- `apps/client/index.html`
- `apps/client/src/main.ts`
- `tests/browser-gameplay.test.ts`

No source, test, or configuration file was edited during verification. No commit was created.

## Commands and results

Commands were run sequentially from `/app`:

| Order | Command | Result |
| --- | --- | --- |
| 1 | `npm run build` | Passed |
| 2 | `npm run typecheck:tests` | Passed |
| 3 | `npx tsx --test tests/browser-gameplay.test.ts` | Passed, 1/1 test |
| 4 | `npx eslint apps/client/src/main.ts tests/browser-gameplay.test.ts` | Passed, no diagnostics |
| 5 | `timeout 180s npm test` | Passed, exit status 0 |

The integrated gate ran because all four focused commands passed. The 180-second wrapper did not fire.

### Focused browser gameplay run

```text
tests 1
suites 0
pass 1
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 10063.174501
```

### Integrated gate

`timeout 180s npm test` includes build, test-source typechecking, full ESLint, and the runtime suite.

| Stage | Result |
| --- | --- |
| `npm run build` | Passed |
| `npm run typecheck:tests` | Passed |
| `npm run lint` | Passed |
| `tsx --test tests/**/*.test.ts` | Passed |

Runtime totals from the integrated gate:

```text
tests 85
suites 0
pass 85
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 60181.475092
```

`git diff --check` exited 0 with no output.

## Disabled assertions

The four new disabled-control assertions in `tests/browser-gameplay.test.ts` lines 129-132 are:

- `Load vessel ... (disabled)`
- `Unload vessel ... (disabled)`
- `Schedule load ... (disabled)`
- `Schedule unload ... (disabled)`

They executed: yes. They are unconditional assertions inside the single non-skipped browser gameplay test, and that test passed both in the focused run and in the integrated gate. No assertion was skipped or marked todo.

## Exported APIs and changed surfaces

- No new package export was introduced.
- `apps/client/src/main.ts` adds internal cargo-availability state and button synchronization.
- `apps/client/index.html` renders cargo controls disabled initially.
- `tests/browser-gameplay.test.ts` adds four assertions for the initial disabled state.

## Boundaries

- No command failed, so no corrective or alternative command was attempted.
- No UI testing was performed.
- No commit was created.

---

# A cargo-reason repair verification

## Scope

Mechanical verification of the A cargo-reason repair in the working tree. Changed files under review:

- `apps/territory-policy/src/actions.ts`
- `tests/browser-gameplay.test.ts`

No source, test, or configuration file was edited during verification. No commit was created.

## Commands and results

Commands were run sequentially from `/app` without alternatives:

| Order | Command | Result |
| --- | --- | --- |
| 1 | `npm run build` | Passed, exit status 0 |
| 2 | `npm run typecheck:tests` | Passed, exit status 0 |
| 3 | `npx tsx --test tests/browser-gameplay.test.ts` | Passed, 1/1 test |
| 4 | `npx eslint apps/territory-policy/src/actions.ts tests/browser-gameplay.test.ts` | Passed, no diagnostics |
| 5 | `timeout 180s npm test` | Passed, exit status 0 |

All four focused commands passed, so the integrated gate ran. The 180-second wrapper did not fire.

### Focused browser gameplay run

```text
tests 1
suites 0
pass 1
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 11456.84708
```

### Integrated gate

`timeout 180s npm test` includes build, test-source typechecking, full ESLint, and the runtime suite.

Runtime totals from the integrated gate:

```text
tests 85
suites 0
pass 85
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 56398.797273
```

## New no-persisted-local-visit assertion

`tests/browser-gameplay.test.ts:138` adds:

```text
assert.match(view.markdown, /Blocked: no-persisted-local-visit/);
```

Executed: yes. It is an unconditional assertion inside the single non-skipped test `real browser Player sessions discover and execute isolated A-to-Registry gameplay` (`tests/browser-gameplay.test.ts:54`). That test passed in both the focused run and the integrated gate, so the assertion ran and did not fail. No assertion was skipped or marked todo.

The paired source change is in `apps/territory-policy/src/actions.ts:36-40`: the visit blocker now takes precedence over the domain-rule reason and emits `no-persisted-local-visit`.

## Boundaries

- No command failed, so no corrective or alternative command was attempted.
- No UI testing was performed.
- No commit was created.
