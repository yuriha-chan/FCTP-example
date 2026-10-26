# Generic host integration verification

## Resulting structure

- `packages/server-base/src/host.ts` publishes persisted public keys at `GET /keys/{name}` for every hosted Actor. Unknown names are left to normal server routing. The host exposes `signObject(name, document: JsonDocument)` while preserving the existing `sign(name, activity)` contract.
- `apps/test-authority/src/bootstrap.ts` no longer owns a duplicate public-key route; it retains authority-specific authorization, setup, and APIs.
- Root build references include `apps/test-authority`, `apps/territory-policy`, and `apps/territory-sim`. Test typechecking references all three app projects alongside package dependencies.
- The foundation signing fixture is typed as `Omit<ExitEvent, 'proof'>`, reflecting that it is unsigned before proof generation.

## Changed files and exported API

- `packages/server-base/src/host.ts`: added `Host.signObject(name: string, document: JsonDocument): Promise<JsonDocument>` and generic key publication.
- `apps/test-authority/src/bootstrap.ts`: removed the authority-specific key route.
- `tests/host.test.ts`: covers generic key publication, unknown-key routing, and custom object signing.
- `tests/foundation.test.ts`: corrected the unsigned ExitEvent fixture type.
- `tsconfig.json`, `tests/tsconfig.json`: added application project references.
- No changes were needed in `tests/authority-bootstrap.test.ts`; its existing assertions verify authority key publication compatibility.

## Verification

Ran `npm test` once, sequentially, as requested:

1. `npm run build` — passed, including authority and both Territory apps.
2. `npm run typecheck:tests` — failed at `tests/sim-domain.test.ts:136`: string indexing has no index signature on the inferred finite commodity object. The previous `apps/territory-sim/src/domain.ts` cargo-ID build error is resolved; the foundation fixture error was corrected here.
3. ESLint and runtime tests were not reached because the required sequential pipeline stops at the failed test typecheck.

No Territory B domain or test files were modified. The remaining typecheck error is outside this unit and unresolved at this checkpoint.
