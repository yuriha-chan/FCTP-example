# Local atomic publication checkpoint

## Scope and API

- Implemented the generic local-publication unit only in `packages/server-base/src/server.ts` and `tests/local-publication.test.ts`.
- `FctpServer.commit(domainMutation, outgoing?, publications?)` now accepts an optional third array of `{ actorId, object, activityId }`. The original two-argument/default behavior remains compatible.
- Publications are wrapped as ActivityStreams `Create`, signed by the configured `signActivity`, persisted by object ID, and appended to the existing Actor `outboxArchive` in the same store transaction as the domain mutation. They do not enter `state.outbox` and do not initiate network delivery.
- `createActivity` takes a required `to` parameter but accepts `to: []`; this yields an empty recipient list, with no fake recipient, and requires no federation API change. `parseActivity` remains an inbound API requiring at least an array-valued `to` field.
- Outgoing and local publication paths share `archivePublication` for exact Activity replay handling, Activity ID conflict checks, object ID conflict checks and object persistence. Outgoing messages enqueue only when archive insertion is new.

## Verification coverage

- Tests exercise an actual `createHost` key/signature, proof cryptography and key attribution, HTTP Actor Outbox and public object retrieval, no local delivery queue item, persisted restart retrieval, object conflict rollback, concurrent commits, and existing outgoing queue behavior.
- No Authority or UI implementation was included.

## Commands

- `npm run build` — passed.
- `npm run typecheck:tests` — passed. An earlier run caught the test fixture calling `close` on `FctpServer`; the fixture was corrected to close its returned listener before the passing run.
- `npx tsx --test tests/local-publication.test.ts` — passed, 2 tests.
- `npx eslint packages/server-base/src/server.ts tests/local-publication.test.ts` — passed. First lint run identified an unused listener variable, which was removed.
- The initial focused test run failed because the fixture generated a persisted key against a temporary origin; the fixture was corrected to reserve a port with `FctpServer` before creating the signed host.
