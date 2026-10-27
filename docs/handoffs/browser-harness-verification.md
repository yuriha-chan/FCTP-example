# Browser harness verification checkpoint

## Mechanical gate

Ran exactly once after the two assigned lint fixes:

`npm run build && npm run typecheck:tests && npm run lint`

- `npm run build` — passed. Included TypeScript project builds, browser client TypeScript compilation, and the generated browser bundle through `apps/demo/build-client.mjs`.
- `npm run typecheck:tests` — passed. Included `tests/` and `apps/client/` TypeScript checks.
- `npm run lint` — passed. ESLint covered `packages apps tests`. The fixes were changing `knownSecrets` from `let` to `const` and expressing the two literal indentation spaces as `\x20{2}` in the assertion regex.

After the gate passed, ran the conditional commands sequentially:

- `npx tsx --test tests/client-server.test.ts` — passed, 1 test; 0 failed, cancelled, skipped, or todo.
- `node --test run/browser-adapter.test.mjs` — passed, 7 tests; 0 failed, cancelled, skipped, or todo.

## Browser harness correction and verification

- The initial focused test exposed `page.evaluate: ReferenceError: __name is not defined` because it imported the TypeScript harness source through tsx/esbuild. Those transforms inject Node-side `__name` helpers that are not available in the serialized browser callback. The production CLI imports `dist/apps/browser-harness/index.js`, emitted by `tsc` without that helper, so the test now imports the same compiled runtime.
- Ran the requested ordered checks after changing the test import:
  - `npm run build` — passed; emitted the runtime used by the test.
  - `npm run typecheck:tests` — passed; included `tests/` and `apps/client/`.
  - `npx tsx --test tests/browser-harness.test.ts` — passed, 1 test; 0 failed, cancelled, skipped, or todo. Chromium launched successfully.
  - `npx eslint tests/browser-harness.test.ts` — passed.
- Building before running the test is faithful to production: the CLI consumes the tsc-emitted JavaScript, and the test now exercises that same compiled harness entry point rather than a tsx/esbuild-transformed TypeScript source module. The source import caused the test-only helper leak into `page.evaluate`; no browser shim or browser app change was needed.
- The focused harness test exercises harness DOM/control behavior, not full client browser integration.
- The previous `npx playwright install-deps chromium` attempt failed because `su` authentication was required. The user subsequently installed the host dependencies; no dependency installation was retried.
- The mechanical build/typecheck/lint sequence and the two focused tests do not exercise the actual client in a browser. Session bootstrap, exact visible Role label/ref resolution, selected Player/vessel behavior, discovery/action UI, operation status, and cleanup remain unverified by browser integration.
- The current label rendering excludes `SELECT` option text from label text so the Role label stays exact. Password filling refreshes the view before the subsequent select ref is resolved. These behaviors have not been verified by browser execution in this checkpoint.
- No live service, fixed port, role, or tick was used or changed.

## Scope

- The build and test-source typecheck included application sources; lint covered `packages/`, `apps/`, and `tests/` and passed.
- The two previously listed focused runtime commands and the browser harness test against the compiled runtime passed. No live service, fixed port, role, or tick was used or changed. Exact machine-readable facts are in `docs/memos/browser-harness-verification.json`.
