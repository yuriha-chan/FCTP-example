# Demo launcher handoff

## Scope and operation

`startDemo({ dataDir, ports?, adminSecrets? })` in `apps/demo/src/launcher.ts` composes the existing authority, policy, and simulation app factories and a bounded browser static server. It binds all listeners to `127.0.0.1`; default ports are authority `4100`, policy `4101`, simulation `4102`, and client `4103`. Configured ports must be distinct positive integers no greater than 65535; port `0` is rejected because service origins are established before listeners bind. Tests select available concrete ports. Durable stores and private key documents are kept separately as `authority.store.json`/`authority.keys.json`, `policy.store.json`/`policy.keys.json`, and `simulation.store.json`/`simulation.keys.json` beneath `dataDir`.

Default local administrator credentials are `demo-authority-admin`, `demo-policy-admin`, and `demo-sim-admin`. The respective environment overrides are `DEMO_AUTHORITY_ADMIN_SECRET`, `DEMO_POLICY_ADMIN_SECRET`, and `DEMO_SIM_ADMIN_SECRET`; `adminSecrets` options override environment values. Credentials are not logged or exposed through the client configuration. This composition is for local development only. The CLI uses `.fctp-data` (gitignored), overridable with `FCTP_DATA_DIR`.

`GET /config.json` publishes only service origins and Actor IDs. Client login remains responsible for authentication/token bootstrap. Static paths are limited to `/`, `/index.html`, `/styles.css`, and `/dist/client/main.js`, with `/config.json` generated dynamically. Other filesystem paths are never served. Static file absence returns 404; unexpected request/file errors return 500 without an unhandled request-promise rejection. Browser output is bundled separately to `dist/client/main.js` by esbuild with browser platform resolution; root build typechecks the browser TypeScript project before bundling, and a missing entry fails the build. `npm run dev` builds once and launches the CLI (no watch mode); `npm start` launches `dist/apps/demo/src/cli.js`, matching the demo project's `rootDir: src` and `outDir: ../../dist/apps/demo`. Importing the launcher does not start a process. The returned handles include all app/service references and an idempotent `close`; it attempts every shutdown, then reports collected failures.

## Changed files and exports

- `apps/demo/src/launcher.ts`: exports `DemoPorts`, `DemoAdminSecrets`, `StartDemoOptions`, `startDemo`.
- `apps/demo/src/cli.ts`: executable entry point with SIGINT/SIGTERM shutdown.
- `apps/demo/tsconfig.json`: project build integration.
- `tests/demo-launcher.test.ts`: actual HTTP integration and lifecycle check.
- `package.json`/`package-lock.json`: pinned direct `esbuild` 0.25.12; build/dev/start scripts.
- Root `tsconfig.json` and test project register the launcher project; `.gitignore` excludes `.fctp-data/`. Root build, typecheck, and test-source typecheck explicitly include `apps/client/tsconfig.json` because it is a no-emit composite project.

## Verification checkpoint

- `npm run build`: stopped at browser source typecheck with `apps/client/src/main.ts(110,26): error TS2554: Expected 4-5 arguments, but got 3.` The client source is owned by the concurrent Client unit. TypeScript stopped before esbuild bundling.
- Test-source typecheck, focused launcher test, and ESLint were not run because the required sequential verification stopped at the build failure.
- Changed files for this checkpoint: `apps/demo/build-client.mjs`, `apps/demo/src/launcher.ts`, `package.json`, `tests/demo-launcher.test.ts`, and this handoff. Exported launcher API remains `DemoPorts`, `DemoAdminSecrets`, `StartDemoOptions`, and `startDemo`.
