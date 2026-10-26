# Integration diagnosis handoff

## Scope

- Diagnosis-only checkpoint. No application or test source files changed.
- Owned deliverables: `docs/handoffs/integration-diagnosis.md` and `docs/memos/integration-diagnosis.json`.

## Prior full-suite result

The latest recorded `npm test` result is from `docs/handoffs/integration-verification.md`: 22 reported tests, 10 passed, 2 failed, 10 cancelled; the script exceeded its 120-second shell timeout. Build, test typecheck, and lint passed before runtime tests. Reported assertions were the EntryRequest binding expectation (`tests/evidence.test.ts:79`) and Home authorization status (`tests/home.test.ts:69`). The Home file was interrupted with a pending promise; the remaining test files were cancelled before execution. This checkpoint did not rerun the full suite.

## Bounded targeted runs

Commands were run individually with a 40-second external timeout; each used the established `npx tsx --test <file>` runner:

| File | Result |
|---|---|
| `tests/evidence.test.ts` | 2 passed, 1 failed. The foreign fixture returned an EntryRequest whose `id` differs from the requested URI; resolver reports `EntryRequest id does not match requested URI` before destination binding. |
| `tests/home.test.ts` | Assertion failed at line 69 (`401 !== 403`), then the test file was interrupted at about 38.7 seconds because a promise remained pending. |
| `tests/policy-territory.test.ts` | Return-with-evidence assertion failed at line 75 (`accepted` was false); the business-rejection test passed. |
| `tests/registry.test.ts` | First test failed at line 38 (cargo remained 5 instead of 8); second test passed. |

The timeout commands exited with the test-runner output; no retries or alternative commands were used.

## Findings and protocol interpretation

- `packages/server-base/src/evidence.ts:69-76` requires the fetched model ID to match the requested URI. It also checks this in the EntryRequest resolution path before `evidence.ts:42-44` checks vessel/Registry and destination binding. `tests/evidence.test.ts:75-76` changes the fixture object's ID while requesting the original `entryId`; thus the test does not currently reach its intended foreign-destination condition. Preserve the request URI and ID, and vary only `destination.territory` to test the destination-binding failure. This is a fixture defect; the URI identity check is required and consistent with the handoff's exact-URI resource convention.
- Evidence-backed return in policy Territory A is currently rejected because the test fetcher at `tests/policy-territory.test.ts:23-30` serves the exit resource but does not serve the original EntryRequest at `exit.entryRequest`. `resolveExitEvidence` fetches that URI at `evidence.ts:39`. In a real flow, `FctpServer.commit` persists outgoing objects by exact object ID (`packages/server-base/src/server.ts:334-342`); the isolated test fabricates/receives the request without the Registry resource endpoint. The fixture should persist and serve the real EntryRequest object under its unchanged `id`/URI. Evidence validity and destination binding should remain distinct from policy acceptance; no cargo should be synthesized or reconciled to hide a missing resource.
- The adopted wire semantics in `docs/handoffs/server-wire.md` and `packages/server-base/src/server.ts:309-318` distinguish authentication from authorization: absent/invalid/revoked credentials produce 401; only a valid authenticated Player denied by `authorizeResource` produces 403. Home rotates the credential before line 69 in `tests/home.test.ts`, so the old token is no longer valid; the 401 is correct. The old-token checks after rotation and revocation (lines 69, 74, 87-88) should expect 401. The test already exercises authenticated denial earlier using a valid token and a false authorization policy at lines 54-57, which should continue to assert 403.
- Registry's first test supplies the inbound verifier callback at `tests/registry.test.ts:21` as `(sender, object) => registry?.resolveExpectedIssuer(sender, object)`. The declared callback contract in `packages/server-base/src/verification.ts:15-19` is `(localActorId, senderActorId, activity)`. The current callback therefore passes the local Registry ID as sender and the sender URI string as the event, rather than the Territory sender and activity object. Expected-issuer verification fails and Registry correctly declines to adopt the cargo event. Fix the fixture callback to forward the actual `senderActorId` and `activity.object`; do not weaken verification or force adoption. The test source does not reveal a nested-queue/read deadlock: `processInbox` verifies and invokes handlers outside a store transaction (`server.ts:171-193`), Registry reads state before entering its transaction (`apps/test-authority/src/registry.ts:74-98`), and the store serial queue awaits prior work (`packages/server-base/src/store.ts:55-75`). The observed Registry failure is an issuer-fixture mismatch, not a demonstrated deadlock.

## Runtime lifecycle and concurrency

- `tests/home.test.ts:99-105` closes both listening authorities and removes its temp directory only on the success path. Its failed assertion leaves both HTTP servers open, explaining the pending test-file interruption after the assertion failure. Put server and directory cleanup in `finally`, including partial-startup handling so every successfully started server closes on failure.
- `tests/registry.test.ts:13-49` and `52-60` likewise close the Authority and remove the temporary directory only on success. It does not listen in the currently failing test, so it did not cause the observed Home hang, but cleanup still belongs in `finally` as required for failure paths.
- `tests/policy-territory.test.ts` already closes the host and removes its directory in `finally` for both tests. `tests/server-wire.test.ts` closes its listener in `finally` and removes its directory in an outer `finally`.
- Root `package.json:11` invokes `tsx --test tests/**/*.test.ts` after sequential build/typecheck/lint stages. Node's test runner may run test files concurrently. Several tests obtain a port by listening on port 0, closing that socket, and later binding the released port (`tests/home.test.ts:108-115`, `tests/registry.test.ts:63-70`, `tests/authority-bootstrap.test.ts:70-77`). That release-then-rebind pattern has a race under concurrent test files. No port-conflict error was reported in the recorded full-suite run or these isolated runs, so this is a risk identified from source, not an established cause of the timeout.

## Suggested repair ownership

Fresh repair agent should own the following test-only changes:

1. `tests/evidence.test.ts`: make the foreign EntryRequest keep the requested `entryId`; alter only its destination and assert the destination-specific binding reason.
2. `tests/policy-territory.test.ts`: make its fetch fixture return the original real EntryRequest by its exact persisted object URI and ID; then check whether the evidence-backed return is accepted and cargo is the signed ExitEvent cargo.
3. `tests/home.test.ts`: update stale/revoked credential expectations to 401, preserve the already-valid authenticated-denial 403 assertions, and guarantee all successfully started authorities/listeners and temp files are cleaned up in `finally` on assertion or setup failure.
4. `tests/registry.test.ts`: conform the test verifier callback to the declared three-argument contract and pass the actual Territory sender plus `activity.object`; add failure-path cleanup for the Authority and temp directory.
5. Inspect concurrent test port allocation when repairing runtime setup; the source demonstrates a possible bind race but this checkpoint did not establish it as the cause.

No application implementation defect is established by the four targeted failures. The evidence resolver's exact identity check and 401/403 distinction match the adopted protocol conventions; the A and Registry failures are explained by incomplete/miswired test fixtures.

## Checkpoint

No UI tests were run. No source files outside the two owned diagnosis documents were changed. No tests/typecheck/lint beyond the four bounded targeted runtime commands were run in this checkpoint.
