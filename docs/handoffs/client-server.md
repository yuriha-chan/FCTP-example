# Standalone client server handoff

## Contract

`startClientServer({ port, host?, config, root? })` is exported from `apps/demo/src/client-server.ts` and returns `{ origin, close }`. Port `0` requests an isolated ephemeral port; `origin` uses the bound port. The config accepts service `origins` for authority, policy, and simulation, with optional actor IDs for registry, home, player, policy, and simulation. Its public type has no credential fields.

The server serves only `/`, `/index.html`, `/styles.css`, `/dist/client/main.js`, and dynamically generated `/config.json`. Static files are resolved below the repository root (default `process.cwd()`), under `apps/client` and `dist/client`; requests do not map arbitrary URL paths to filesystem paths. It starts no game services. `startDemo` delegates its client listener to this server and retains its existing API and client config.

## Changed files and exports

- `apps/demo/src/client-server.ts`: standalone HTTP server API and public config types.
- `apps/demo/src/launcher.ts`: reuses the extracted server.
- `tests/client-server.test.ts`: actual HTTP test for static assets, public config, allowlist, ephemeral origin, and shutdown.
- `docs/handoffs/client-server.md`: this API and verification checkpoint.

## Verification

- `npx tsc -p apps/demo/tsconfig.json --pretty false` passed; this compiled the demo source, including `launcher.ts` and `client-server.ts`.
- `npx eslint apps/demo/src/launcher.ts apps/demo/src/client-server.ts tests/client-server.test.ts` passed.
- The bundle was absent at the initial check, so `node apps/demo/build-client.mjs` built the existing browser bundle for the real-HTTP test.
- `npx tsx --test tests/client-server.test.ts` passed (1 test; actual HTML, CSS, bundle, config, allowlist, ephemeral port, and close behavior).
- No game service was started by the standalone-server test. Broader checks were not run.
