# Server wire interoperability handoff

## Scope and behavior

- Persistent object GETs use the exact absolute request URI for resource lookup and persisted `state.objects` lookup. A path-tail identifier is no longer used as a fallback key.
- Inbox token declarations are recognized from their `tokenDigest` or `tokenRevoke` shape as well as a declared `type`; existing `validateModel` validation remains in force, and FCTP fields were not made mandatory.
- Invalid diplomatic-token encodings authenticate as absent credentials. Protected GET returns 401 for missing/invalid credentials and 403 when an authenticated Player is denied by resource policy.
- `tests/server-wire.test.ts` covers post-restart GETs of a committed EntryRequest and cryptographically signed ExitEvent, a conflicting path-tail decoy, structural TokenDigest/TokenRevoke delivery, and protected-GET status distinctions.
- `tests/sim-domain.test.ts` annotates its test configuration helper as the declared `SimulationConfig` type.

## API and files

- No exported API changes.
- Changed: `packages/server-base/src/server.ts`, `tests/server-wire.test.ts`, `tests/sim-domain.test.ts`.
- Added this handoff: `docs/handoffs/server-wire.md`.

## Mechanical check

- `npm test` was run sequentially. `npm run build` and `npm run typecheck:tests` passed. ESLint stopped the script on the existing unused `URI` import in `packages/server-base/src/host.ts:4`; `tsx --test` consequently did not run. The host file is outside this assignment, so it was left unchanged.

## Checkpoint

Wire repair and mechanical-check handoff are complete. Runtime test results remain unverified because the existing lint error prevents the `npm test` script from reaching its test runner.
