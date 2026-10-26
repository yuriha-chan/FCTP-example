# Registry handoff

## Scope and API

`apps/test-authority/src/registry.ts` exports `installRegistry(authority, options)`. It adds a persistent demo vessel and cargo manifest to the authority domain store, `sendEntry`, `sendDeparture`, `switchAdoption`, `state`, and `resolveExpectedIssuer`. Territory discovery is injectable with `route`; otherwise the configured Fetch implementation retrieves the Territory Actor and inbox. A received event is model-validated and requires all three inbound verification dimensions to pass. Entry rejection, berthing, departure and exit references bind to the exact locally issued request; unlinked cargo/voyage messages are resolved only against the latest issued entry request for that vessel. EntryRejected issuer selection uses the issued request's destination and does not require a vessel field. Event IDs are persisted as application replay guards. Accepted ExitEvent objects are persisted in `store.objects` and referenced by URI in state; exit evidence uses shared `resolveExitEvidence`, with Registry-side checks for local request issuance and optional departure linkage.

CargoOperationEvent cargo is applied as an operation delta to Registry-reported cargo only when adoption is enabled. Stack identity is variety plus canonicalized data; Item identity is ID. Unloads that exceed or do not match the current cargo are ignored without recording the event or mutating cargo. With adoption off, events are recorded without altering cargo. Local entry/departure, adoption, and state routes remain under `/local/registry` and use `server.checkAdmin`.

## Expected issuer integration

Pass a closure to `createInboundVerifier({ resolveExpectedIssuer })` which delegates to the installed Registry's `resolveExpectedIssuer(sender, object)`. The helper accepts only an issued matching vessel request and the expected sender/territory relationship. The closure can be created before `installRegistry`; it is invoked only when inbox processing occurs.

## Changed files and exports

- `apps/test-authority/src/registry.ts`: Registry installation API, persistent domain state, request-linked event handling, cargo delta adoption, shared evidence resolution, and local admin routes.
- `tests/registry.test.ts`: signed-envelope integration coverage for non-adoption/adoption deltas, impossible unload, forged vessel, persistence, and EntryRejected expected-issuer selection.
- `docs/handoffs/registry.md`: this handoff.
- `docs/memos/registry-review.json`: structured checkpoint findings.

## Verification and checkpoint

| Command | Result |
| --- | --- |
| `npm test` | Both attempts stopped during `npm run build` at unrelated `apps/territory-sim/src/territory.ts:185` TS18048 (`evidence` possibly undefined). The first build also surfaced Registry narrowing errors, corrected before the second attempt. Test-source typecheck, ESLint and test execution were not reached. |

Registry implementation and tests are written, but execution of the new tests, ESLint, and the remainder of the root pipeline is blocked at the unrelated Territory build error. No Home, Territory, bootstrap, root, or configuration files were changed. Stop here for supervisor review; no subsequent unit was started.
