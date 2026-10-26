# Inbound Activity verification handoff

## Scope

Implemented a reusable server-side inbound Activity verifier. The adapter resolves the declared sender Actor, fetches only public-key documents listed by that Actor, uses the existing allowlisted identity loader for fixed contexts, verifies the signed Activity envelope, checks key attribution, and separately asks the caller to resolve the expected publisher. It makes no application or economic trust decisions.

## API

`createInboundVerifier({ fetcher?, loader?, resolveExpectedIssuer })` returns the `FctpServerOptions['verifyInbound']` callback. `resolveExpectedIssuer(localActorId, senderActorId, activity)` supplies application-specific expected-publisher logic; returning `undefined` or throwing yields `expectedIssuer.matches: false`. Actor resolution, proof verification, and attribution failures remain represented in their corresponding report dimensions.

The optional loader is used for fixed locally available JSON-LD contexts. The adapter adds explicitly fetched public-key documents to that loader; it does not fetch arbitrary contexts. No economic-trust fields are part of the report.

## Changed files and exports

- `packages/server-base/src/verification.ts`: implementation and `InboundVerifierOptions` / `createInboundVerifier` exports.
- `packages/server-base/src/index.ts`: exports the verification adapter.
- `tests/verification.test.ts`: real `eddsa-rdfc-2022` envelope verification, tampering, wrong Actor, key-controller mismatch, missing expected issuer, and unavailable Actor/key coverage.
- `docs/handoffs/verification.md`: this API and acceptance record.

## Protocol boundary

Protocol §6 requires JSON-LD Data Integrity proofs and support for `eddsa-rdfc-2022`, with public keys discoverable through the Actor's `publicKeys`. Section 9 describes signed event claims and distinguishes them from business acceptance. Section 10 concerns remote-resource token authorization, not proof of Activity publisher identity. This adapter validates message identity only; application handlers retain policy responsibility.

## Verification results

Each requested command was run once. The lint issue was corrected afterward; the checks were not rerun.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed (exit 0). |
| `npm run lint` | Failed on an unused catch binding in `verification.ts`; the binding was removed after the run. Not rechecked. |
| `npm test` | Failed: the existing seven foundation tests passed, but the new test module could not import `createInboundVerifier` from the package at runtime. The command ran concurrently with typecheck. Not rechecked. |

## Checkpoint

Supervisor verification after the local lint correction ran `npm run typecheck && npm run lint && npm test` sequentially. All commands passed; 10 tests passed. The runtime import failure was caused by running tests concurrently with the build that emits package exports. Build-dependent checks must run sequentially. No app workflows, app setup, configuration, dependencies, or commits were added.
