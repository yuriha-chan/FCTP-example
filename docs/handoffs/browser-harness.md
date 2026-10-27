# Browser harness checkpoint

## Scope and exports

- Implemented only the generic browser harness under `apps/browser-harness/`; no run adapter, application UI, or static server was added.
- `apps/browser-harness/src/index.ts` exports `createBrowserSession`, `BrowserSession`, `TextView`, and `CreateBrowserSessionOptions`.
- The session launches an isolated Chromium context, navigates only to allowed origins, aborts requests to other origins, renders the live visible DOM, and operates on real input/select/button/link/form elements. Opaque refs are generation-scoped; hidden/disabled/wrong-kind/stale refs are rejected.
- DOM rendering omits hidden content and executable/style elements, preserves `pre` whitespace, includes headings/text/links and labelled controls/options/states, masks sensitive fields and values injected through `fill`, and settles on the client busy marker plus network quiet.
- `tests/browser-harness.test.ts` covers a real isolated form fixture, JavaScript event handlers and submission, DOM rendering, secret masking, stale/disabled refs, selection, navigation, session isolation and rejected initial origins.

## Dependency and browser

- Added exact `playwright@1.56.1` dev dependency; `npm install` exited 0 and updated `package-lock.json`.
- `npx playwright install chromium` exited 0; Chromium 141.0.7390.37 (Playwright build v1194), ffmpeg, and headless shell downloaded. Playwright emitted a host dependency validation warning listing missing Linux browser libraries.

## Build checkpoint

- `npm run build` was attempted twice. First attempt found a harness selector-handle generic mismatch, corrected locally. Second attempt stopped at the unrelated existing app-client diagnostic `apps/client/src/main.ts(138,136): TS18048: 'session' is possibly 'undefined'`.
- The focused test, test-source typecheck, and scoped ESLint were not run after this unrelated UI compile error, per the assigned checkpoint instructions. Harness behavior is therefore not yet verified by an executed focused test.

## Bounded semantic repair checkpoint

- `apps/browser-harness/src/index.ts`: ordinary filled values are no longer registered as secrets; values are tracked only when filled into password fields or fields with sensitive labels/names. Rendering walks mixed descendants so hidden descendants are omitted and nested links/buttons/controls remain represented; labels derive text from visible descendants. `submit` only accepts submit-capable buttons and submit/image inputs, while button-type controls are rejected before form submission. Removed the unused `Page` import.
- `tests/browser-harness.test.ts`: added checks for ordinary typed text visibility, hidden paragraph descendants, nested links, disabled controls remaining blocked, and rejection of a button-type control by `submit`.
- Attempted the assigned prerequisite `npx playwright install-deps chromium`; it failed because package installation escalated to `su` and authentication failed (`Installation process exited with code: 1`). Per the bounded assignment, stopped here. Root build/test-source check, focused harness test, and scoped ESLint were not run.
- Changed owned files: `apps/browser-harness/src/index.ts`, `tests/browser-harness.test.ts`, `docs/handoffs/browser-harness.md`.

## Changed files

- `apps/browser-harness/src/index.ts`
- `apps/browser-harness/tsconfig.json`
- `package.json`, `package-lock.json`
- `tsconfig.json`, `tests/tsconfig.json`
- `tests/browser-harness.test.ts`
- `docs/handoffs/browser-harness.md`

## Mechanical verification checkpoint

- Applied the bounded lint fixes: `knownSecrets` is declared `const`, and the test regex expresses the two literal indentation spaces as `\x20{2}` with the same matching behavior.
- Ran `npm run build && npm run typecheck:tests && npm run lint` exactly once. All stages passed. Build included TypeScript project builds, browser client compilation, and the generated browser bundle; test-source typechecking included `tests/` and `apps/client/`; lint covered `packages apps tests`.
- After the gate passed, ran `npx tsx --test tests/client-server.test.ts` and `node --test run/browser-adapter.test.mjs` sequentially. Both passed: 1/1 client-server test and 7/7 browser-adapter tests.
- Browser launch and Playwright-dependent tests remain pending the user's ready confirmation after installing host browser dependencies. `npx playwright install-deps chromium` previously failed when `su` required authentication; no install was retried and no browser was launched.
- No browser was launched and no Playwright-dependent browser test was run. The mechanical gate and focused tests do not verify real-client behavior through a browser. Actual client session bootstrap, rendered Role label/ref handling, role/vessel selection, discovery/actions, and operation-status behavior remain unverified by browser integration in this checkpoint.
- The label rendering change excludes `SELECT` option text from label text so the bootstrap Role label remains exact; password fill refreshes the view before resolving the subsequent select reference. Those semantics were not exercised by a browser test here.
- Exact command outcomes and scope are also recorded in `docs/handoffs/browser-harness-verification.md` and `docs/memos/browser-harness-verification.json`.
