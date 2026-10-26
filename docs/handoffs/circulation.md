# HTTP circulation acceptance handoff

## Ownership and coverage

- `tests/circulation.test.ts` is one actual-HTTP acceptance unit. It creates A, B and the real test Authority on three free loopback ports using their application factories and real stores/keys.
- Home issues an actual Player native credential and signed per-Territory TokenDigest deliveries; experimental operations use the resulting Player diplomatic credentials. Administrative routes use a distinct bearer credential.
- The test explicitly pumps each server's real Inbox/Outbox workers. Registry EntryRequest and Territory event deliveries use signed Activity wrappers and HTTP POSTs; evidence and ExitEvents are fetched from their published HTTP references.
- A mines ore, consumes two ore in manufacture, transfers metal to port stock, loads the vessel, and the Registry adopts its CargoOperationEvent. A's ExitEvent is separately checked for cryptographic proof, key attribution, expected publisher, and binding to the Registry's original EntryRequest.
- Registry sends B the exact A ExitEvent reference and matching manifest. B's decision verifies the evidence; berth completion waits for a tick. A delayed unload moves A's original metal URI into B raw stock only after completion. Imported manufacture reserves and consumes that input, completed refined output is reloaded, and B exits with a separately verified signed ExitEvent bound to B's EntryRequest.
- A Registry adoption-off window shows B's completed unload persists in B while Registry inventory remains unchanged. B's load operation is adopted after adoption is restored.
- B-native mining/manufacture checks an HTTP shortage rejection, uncompleted output reservation, immediate ingredient reservation, and tick-completed output.
- A separate mismatch entry gives A an empty declared manifest against B's real exit evidence. A retains an explicit `cargo-mismatch` decision and descriptive difference; no inventory or Registry declaration is rewritten.
- Test output emits sanitized real Activity wrappers, fetched ExitEvent objects, verifier/binding reports, and the mismatch decision. Credentials, native tokens and private key material are excluded.

## Verification

The assigned commands are run in order:

1. `npm run build && npm run typecheck:tests`
2. `npx tsx --test tests/circulation.test.ts`
3. `npx eslint tests/circulation.test.ts`

Final outcomes:

- `npm run build && npm run typecheck:tests` passed. The build prints `Browser bundle pending: apps/client/src/main.ts is not present.` but exits successfully.
- `npx tsx --test tests/circulation.test.ts` passed: five tests including the parent and four distinct circulation checkpoints; zero failures.
- `npx eslint tests/circulation.test.ts` passed with no output.

The requested circulation check does not build or test the browser UI.

## Contract boundary

No application, shared package, or root configuration/source files are changed. Registry cargo adoption remains independent of the Territory's completed operation; evidence verification is factual and does not itself authorize inventory reconciliation. This handoff stops at the circulation acceptance checkpoint.
