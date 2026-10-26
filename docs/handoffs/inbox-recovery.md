# Inbox recovery handoff

## Queue policy

- `processInbox(limit)` serializes invocations per server and returns the count of successfully completed items. A call considers each eligible item at most once; retrying an item never causes a tight loop.
- Eligible work is selected from anywhere in the queue by `nextAttemptAt`, with absent fields treated as immediately eligible for old snapshots. Processing failures retain the original Activity and its deduplication hashes, increment `attempts`, record `diagnostic`, and schedule a retry after `min(60s, 500ms * 2^min(attempts, 7))`.
- Verification errors and negative verification reports both remain pending and use delayed retry; they are not proof of cryptographic invalidity.
- A structurally invalid `TokenDigest` or `TokenRevoke` declaration is moved into `inboxRejected` with recipient Actor, Activity ID, optional object ID, sender, receipt time and diagnostic reason. Its original payload identity remains protected by the existing deduplication hashes.
- Other parsing, verification, token-application, and handler errors remain pending. The call processes other eligible messages, then rejects with an `AggregateError`, keeping failures observable to host worker error reporting.
- Handler effects must remain idempotent. Domain changes and outgoing delivery can be guarded and committed atomically through the existing store transaction/`FctpServer.commit` APIs.

## Changed files and API

- `packages/server-base/src/server.ts`: durable recovery, quarantine, serialized processing and preserved `Promise<number>` API.
- `packages/server-base/src/store.ts`: optional inbox retry fields and rejected declaration records; old snapshots load with defaults.
- `tests/inbox-recovery.test.ts`: quarantine does not block eligible work, handler failure retention/restart retry and observable verifier failure.
- `docs/memos/inbox-recovery.json`: structured checkpoint.
- No game policy or signature acceptance behavior changed.

## Verification

`npm run build && npm run typecheck:tests` passed. `npx tsx --test tests/inbox-recovery.test.ts` passed (2 tests). `npx eslint packages/server-base/src/server.ts packages/server-base/src/store.ts tests/inbox-recovery.test.ts` passed. Sources compiled included the server package and TypeScript test sources; no app source changes were made.
