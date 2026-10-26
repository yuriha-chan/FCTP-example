# Simulation application factory handoff

## Scope and exports

- `apps/territory-sim/src/app.ts` exports `createSimulationApp(options)`, `CreateSimulationAppOptions`, `SimulationAppIds`, and `SimulationApp`.
- Options are `origin`, `storeFile`, optional `keyFile`, `authorityOrigin`, `peerOrigin`, `adminSecret`, and optional `fetcher`. The factory returns `{ host, territory, ids }`; it does not listen or start workers.
- `ids.ports`, `ids.routes`, and `ids.assets` are arrays of actual local Port, Route, and Asset URIs. `ids.actor.resources.ports` and `.routes` remain Collection URIs. `ids.varieties.importedMetal` retains A's URI and no B-side imported Variety is registered or asserted.
- Token declarations require the declared Player to be enrolled with the sending Home and the local Territory in the activity recipients. Departure issuer resolution uses persisted active visits and their recorded Registry; unknown senders do not match the adapter's issuer helper.
- The Territory publishes local ore, metal, and refined varieties; imported metal is only referenced by its original A URI. Text assets and the ASCII map resource are served as actual `text/plain; charset=utf-8` through a custom route. The map descriptor and assets require an enrolled Player resource token; unauthenticated or invalid credentials receive 401 and authenticated non-enrolled credentials receive 403.
- Local endpoints: public `GET /local/info`; Player or admin `GET /local/state`; Player-only `POST /local/mine`, `/local/manufacture`, `/local/load`, `/local/unload`; administrator-only `POST /local/admin/facilities` and `/local/admin/tick`. Admin credentials do not authorize Player operations. Input cargo is `{ cargo: { entries: Quantity[] } }`; Item identities/data and Stack variety/count/data map into distinct simulation cargo records. Facility sections and fields are validated before domain configuration.
- Actor capabilities use the profile URI conventions rather than unsupported `fctp:*` claims.

## Verification checkpoint

- Updated the focused HTTP test for protected text/descriptor resources, authentication status, Player/admin separation, and invalid rich cargo.
- `npx eslint apps/territory-sim/src/app.ts tests/sim-app.test.ts` passed after correcting the focused lint finding.
- Type checking and app test execution were not run during parallel writes. Supervisor integration gate remains pending.

## Files in this unit

- `apps/territory-sim/src/app.ts`
- `tests/sim-app.test.ts`
- `docs/handoffs/sim-app.md`
