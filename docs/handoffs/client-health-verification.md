# Client health verification

## Scope

Verification-only check of the current working tree after browser CLI sources and eight CLI tests were migrated into tracked paths. No files were edited during this verification.

## Command and result

Ran exactly once from `/app`:

```text
timeout 180s npm test
```

Passed with exit status 0; the 180-second wrapper did not fire. `git diff --check` also exited 0 with no output.

| Stage | Result |
| --- | --- |
| Build (`npm run build`) | Passed, including generated browser bundle |
| Test-source typecheck (`npm run typecheck:tests`) | Passed |
| ESLint (`npm run lint`) | Passed, no diagnostics |
| Runtime (`tsx --test tests/**/*.test.ts tests/**/*.test.mjs`) | 104 passed; 0 failed, 0 skipped |

Runtime totals: 104 tests, 0 suites, 104 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo; duration 80397.556873 ms. The eight migrated `tests/browser-adapter.test.mjs` tests exercised the tracked CLI parser/config/role/ref behavior and Unix socket transport; CLI spawn checks use canonical `scripts/browser*.mjs` sources. Other automated coverage included rendered client controls, restored Player/administrator controls, browser batching, authoring, and gameplay. This is bounded automated evidence, not human UI acceptance or complete client-flow coverage. No world was launched, no tick was advanced, and no commit was created.
