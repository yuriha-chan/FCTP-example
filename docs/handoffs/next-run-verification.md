# Next-run broad-gate verification

## Scope

Mechanical verification of the current working tree after the non-owner Asset readability and Territory A audit/Variety-permit changes. No production or test code was edited. No commit was created.

## Command

Exactly one sequential gate was run from `/app`:

```text
timeout 180s npm test
```

The 180-second wrapper did not fire.

## Result

Passed. Exit status 0.

| Stage | Command inside `npm test` | Result |
| --- | --- | --- |
| Build | `npm run build` (`tsc -b`, client `tsc`, `node apps/demo/build-client.mjs`) | Passed |
| Test-source typecheck | `npm run typecheck:tests` (`tsc -p tests/tsconfig.json`, client `tsc`) | Passed |
| ESLint | `npm run lint` (`eslint packages apps tests`) | Passed, no diagnostics |
| Runtime tests | `tsx --test tests/**/*.test.ts` | Passed |

Runtime totals from the runner:

```text
tests 85
suites 0
pass 85
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 55074.43836
```

App sources were exercised by the build and ESLint stages; test sources and the browser client were included in the test-source typecheck. Runtime coverage included the rendered browser authoring harness, actual HTTP circulation, policy audit attribution, and Variety port-permit tests.

## Browser bundle

The build produced `dist/client/main.js`:

- Exists: yes
- Size: 490696 bytes
- Mtime: 2026-10-27 09:35:42 UTC

The mtime is from the build stage of this gate.

## Whitespace check

`git diff --check` exited 0 with no output.

## Boundaries

- No failing test, build, typecheck, ESLint, or runtime stage was observed.
- No alternative commands, broad repairs, or additional broad gates were run.
- No commit was created.
- No browser UI acceptance beyond the automated rendered harness is claimed.
