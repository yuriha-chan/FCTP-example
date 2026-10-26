# Integration fixture repair handoff

## Scope and changes

- Completed the integration fixture repair checkpoint in the assigned test and documentation paths only; no application implementation files changed.
- `tests/evidence.test.ts`: preserved the requested EntryRequest ID/URI while changing only its destination territory in the foreign-destination binding case.
- `tests/policy-territory.test.ts`: serves the original EntryRequest and linked DepartureEvent/DepartureRequest at their exact IDs. The fake fetcher removes URI fragments for HTTP routing, so a key ID ending in `#key-1` retrieves its fragment-free endpoint while returning the original public-key document. The evidence-backed return assertion includes the complete decision (reason and verification details) in its failure output.
- `tests/server-wire.test.ts`: registers the protected resource using the URI built from the listener's actual port.
- `tests/registry.test.ts`: corrected the `createInboundVerifier` callback to accept `(localActorId, senderActorId, activity)` and resolve the Registry issuer using the actual sender plus `activity.object`. Both tests close any created Authority and remove temporary storage in `finally`.
- `tests/home.test.ts`: retained the valid authenticated policy-denial assertion as HTTP 403; stale credentials after rotation/revocation expect HTTP 401. Both authorities and temporary storage are cleaned in `finally`, including setup/assertion failures.
- Existing evidence and binding assertions were retained. No exported APIs changed.

## Verification

Command: `timeout 180s npm test` (sequential pipeline; run once after the final fixture changes).

- Build: passed.
- Test typecheck: passed.
- ESLint: passed.
- Runtime: 42 tests reported; 42 passed, 0 failed, 0 cancelled, 0 skipped. Completed in 6820.832137 ms; no timeout or hanging test.

## Findings / blockers

- The policy Territory fixture's key document IDs contain `#key-1`; simulated HTTP fetch routing now strips the fragment when matching the resource URI, while the public document retains its key ID.
- The wire fixture now registers and requests the same absolute resource URI, including the active listener port.
- No blockers remain at this checkpoint.

No UI tests were run. The checkpoint stops here.
