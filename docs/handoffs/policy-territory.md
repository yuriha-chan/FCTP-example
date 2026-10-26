# Policy Territory federation adapter handoff

## Scope and changed files

This checkpoint composes Territory A's existing policy domain with generic hosting and federation. It exposes public-port metadata and registers generated event objects as retrievable resources; it adds no HTTP application or UI.

- `apps/territory-policy/src/territory.ts`
- `apps/territory-policy/src/domain.ts`
- `tests/policy-territory.test.ts`
- `docs/handoffs/policy-territory.md`

## Exported API and behavior

- `installPolicyTerritory(host, options)` takes a configured Actor name, owned port and route URIs, known commodities, initial policy, optional Registry/Territory acceptance lists, mismatch policy (`declared`, `evidence`, or `reject`), optional public ports, fetcher, and clock. `updateAdmissionPolicy` persistently modifies admission lists, mismatch behavior, and public ports.
- The returned adapter exposes persisted `state` and `ledger` promises plus `mine`, `manufacture`, warehouse/port transfer, `load`, `unload`, and `updatePolicy`. Adapter operations and inbound handlers share a serial queue.
- Ledger data is stored under `domain.policyTerritory`; it contains the existing policy-domain state, persistent admission configuration, active/archived visit records, policy-snapshotted decisions, inbound/evidence verification facts, and processed Activity IDs. Departure archives the exact signed exit cargo on the visit and removes the active domain vessel in the same commit; re-entry can recreate its active vessel slot.
- Entry and departure handlers require all inbound verification report fields to be positive, runtime-validate objects, bind sender to Registry, and check local territory/port/route and active visit. Unverified inbound messages are ignored rather than treated as business rejections. Verified business denials persist a decision and enqueue `EntryRejected`; accepted entries emit `BerthingEvent`. Entry resolves optional Exit evidence with `resolveExitEvidence`; authenticity and local acceptance remain separate. Cargo deltas are emitted only for successful immediate load/unload. Departure atomically archives the visit, removes the active vessel, and enqueues DepartureEvent plus a nested-proof ExitEvent signed with `Host.signObject`. Generated A event IDs use `{origin}/objects/policy/...` and are registered for GET retrieval. Public ports are exposed at `{origin}/objects/policy/public-ports`.
- `expectedIssuer(object, visits)` resolves the Registry for EntryRequest and the active visit's Registry for DepartureRequest.

## Checks and blockers

- `npx tsc -b apps/territory-policy/tsconfig.json --pretty false` passed (app source included).
- The focused `npx tsx --test tests/policy-territory.test.ts` fails on the return-with-cargo assertion: the persisted decision is rejected rather than accepted after evidence-backed re-entry. The business-rejection delivery/policy-update test passes. Diagnosis remains unresolved; no further checks were run after this failure.
- ESLint was not run in this checkpoint because the focused test failed.
- `npm run typecheck:tests` is blocked by the existing unrelated `tests/sim-domain.test.ts:136` TS7053 string-indexing error. `npm run build` is blocked by unrelated existing TypeScript errors in `apps/test-authority/src/registry.ts:188,194,196` (unknown quantity count/indexing).
- `tests/sim-territory.test.ts` was run to diagnose host verification behavior; both tests currently fail because inbound verification reports key unattributed/issuer mismatch. This pre-existing foundation/application integration issue prevents this adapter test from reaching its business-policy assertions.

## Findings

`FctpServer.commit` signs outbound Activity envelopes before atomically committing domain mutation and outbox records. Entry evidence verification failures never become trusted evidence; local decisions also capture the factual verification report and binding result. Registry adoption/notification is outside this adapter and cannot alter its local ledger. The remaining return-evidence failure blocks this checkpoint; inspect evidence resolver fetching/issuer binding before continuing.
