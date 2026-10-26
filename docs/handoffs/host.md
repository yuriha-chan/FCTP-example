# Generic persistent Actor host handoff

## Contract

`createHost(options)` in `@fctp/server-base` creates a persistent `FctpServer` and one stable Ed25519 Multikey per descriptor. `origin` must be an HTTP(S) origin; `storeFile` names the server snapshot; `keyFile` optionally overrides the default `{storeFile}.keys`. The key file stores private key documents, is created with mode `0600`, and is reset to that mode when loaded. Each public key identifier is `{origin}/keys/{name}#key-1`.

Each `actors` entry is `{ name, role, document? }`. Names must be unique, non-empty, and contain no slash; roles must be non-empty. Without `document`, the host creates a Service Actor at `{origin}/actors/{name}` with inbox/outbox URLs and the descriptor role. A supplied document must have that ID and list its persisted key in `publicKeys`. Actor and key files are keyed by descriptor name.

`fetcher` supplies remote fetching. `verifyInbound` replaces verification; otherwise the host uses `createInboundVerifier`, loading local key documents locally and resolving remote Actors/keys with the fetcher. `resolveExpectedIssuer(localActorId, senderActorId, activity)` is passed to that verifier. Its default resolves to unknown, which yields a failed expected-issuer result. `authorizeAdmin` and `authorizeResource` inject the server's existing authorization checks; admin access defaults to denied. `inboxHandlers` maps Actor name to object type to handler. `configure(server, actors, keys)` adds role-specific routes or setup after server construction and before opening/registration.

The returned host exposes `server`, named `actors` and `keys`, local `loader`, `actor(name)`, `key(name)`, and `sign(name, activity)`. It also exposes `listen`, `startWorkers`, `stopWorkers`, and `close`. Workers process inbox then outbox, sequentially. An inbox or outbox failure is retained in the observable `workerErrors` list and passed to `onWorkerError`; callback failures are also retained. A failed phase does not reject the worker promise chain or stop subsequent cycles. Inbox items remain queued on processing failure, so a poison item can continue generating observable worker errors; queue repair is outside this host contract.

## Authority adapter

`apps/test-authority/src/bootstrap.ts` uses three fixed descriptors (`registry`, `home`, `player`) and retains `createAuthority`, `actor`, `key`, `registerActor`, `listen`, worker lifecycle, and server-facing APIs. It owns the `/keys/{role}` public-key route and authority-specific admin-secret authorization. Hosting, persisted keys, signing, and worker lifecycle live only in server-base.

## Changed files and exports

- `packages/server-base/src/host.ts` exports `HostActorDescriptor`, `HostWorkerError`, `CreateHostOptions`, `Host`, and `createHost`.
- `packages/server-base/src/index.ts` exports the host API.
- `apps/test-authority/src/bootstrap.ts` is the authority adapter.
- `tests/host.test.ts` checks stable named keys and observable recurring poison-inbox failures; `tests/authority-bootstrap.test.ts` covers compatibility and authority behavior.
- Root workspace checks include the app and test sources; `npm test` runs build, test typecheck, lint, and tests sequentially.
- `.gitignore` ignores dependency, build, state, and TypeScript build-info outputs.

## Verification checkpoint

`npm test` ran sequentially. `npm run build` passed, including the newly referenced authority app. `npm run typecheck:tests` compiled the app/test dependency graph and failed on pre-existing errors outside this unit:

- `apps/territory-sim/src/domain.ts:128`: `unknown` cargo ID is not assignable to `string`.
- `tests/foundation.test.ts:70`: `ExitEvent.proof` is missing.
- `tests/sim-domain.test.ts:130`: string indexing lacks an index signature.

Because the required sequence stops at the failed test typecheck, lint and runtime tests were not reached. No unrelated domain/test errors were repaired.
