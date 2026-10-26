# Exit evidence handoff

## API

`resolveExitEvidence(uri, expected, options?)` is exported from `@fctp/server-base`. `expected` contains `vessel` and `registry` URIs; `options.fetcher` can supply a Fetch-compatible resolver. The result exposes the validated ExitEvent when available, the resolved EntryRequest when available, a `VerificationReport`, factual `binding` status and reason, and an optional resolution error. `difference` is reserved with type `never` for a stable result signature.

The ExitEvent is fetched by URI, runtime-validated, and independently checked for proof cryptography, key attribution against the declared territory Actor, and territory publisher identity. The referenced EntryRequest is fetched and validated, must have the requested ID, must refer to the expected vessel and Registry, and must name the signed ExitEvent territory as its destination. An optional DepartureEvent is validated alongside its DepartureRequest reference, and vessel, territory, and request linkage are checked. A matching unsigned EntryRequest reports `entry-request-publisher-unproven`; retrieval and URI availability do not establish publisher identity or economic trust.

`verification.ts` now exports `verifyPublishedDocument` to share Actor/key-document loading and proof verification with inbound Activity verification. Exit evidence verifies the ExitEvent object itself, not an Activity envelope.

## Changed files and exports

- `packages/server-base/src/evidence.ts`: `resolveExitEvidence`, expected/options/result types and evidence resolution.
- `packages/server-base/src/verification.ts`: shared signed-document verification helper, used by the inbound verifier and evidence resolver.
- `packages/server-base/src/index.ts`: appended evidence export.
- `tests/evidence.test.ts`: signed evidence, tampering, controller attribution, missing reference, and foreign destination cases.
- `docs/handoffs/evidence.md`: this API and checkpoint record.

## Verification results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed (exit 0; package project build/typecheck). |
| `npm run build && npm run typecheck:tests && npx tsx --test tests/evidence.test.ts` | Build passed. Test-source typecheck stopped the sequential command on pre-existing `tests/sim-domain.test.ts:136` TS7053 (string indexing without an index signature). The focused evidence tests were not run. No out-of-scope test source was changed. |
| `npm run lint` | Not run because the required sequential test command stopped at the test-source typecheck failure. |

## Checkpoint

The shared API and implementation are in place. Mechanical verification is blocked before the focused test and lint stages by the unrelated test-source type error above. No host behavior, application code, root/configuration files, or dependencies were changed. No next workflow was started.
