# Test authority bootstrap handoff

## Scope

Implemented reusable persistent hosting for a minimal Registry, Home, and Player using `FctpServer`. Each Actor has an independent inbox/outbox and Ed25519 Multikey key. There are no token, vessel, or application-operation workflows.

## API

`createAuthority({ origin, storeFile, keyFile?, adminSecret?, fetcher?, verifyInbound?, authorizeResource?, onInbound?, inboxHandlers? })` opens the persistent server and registers the three Actors. `origin` must be an HTTP(S) origin. Actor IDs are `{origin}/actors/{registry|home|player}`; their role-specific WebFinger names follow the local conventions.

The result exposes:

- `server`: the `FctpServer`, including its existing `on`, `addRoute`, `publish`, `receive`, `processInbox`, `processOutbox`, and resource methods.
- `actors`, `actor(role)`, `keys`, and `key(role)` for Actor documents and their signing key pairs.
- `registerActor(role, actor)`, which checks the role and persisted-key identity before registration.
- `listen(port?, host?)`, `startWorkers(intervalMs?)`, `stopWorkers()`, and `close()`. Workers are explicit and process inbox work followed by outbox delivery; `close()` stops workers and closes HTTP.
- `verifyInbound` injection and `onInbound(server, actors)` / `inboxHandlers` hooks for composing application verification and callbacks.

Private Multikey documents are stored in `{storeFile}.keys` unless `keyFile` is supplied. The file is created and reset to mode `0600`; the persisted Ed25519 key material is imported using the maintained `@digitalbazaar/ed25519-multikey` library. Public key IDs have fragment identifiers at `/keys/{role}#key-1`; a `FctpServer.addRoute` handler serves their public Multikey documents at `/keys/{role}`, where HTTP omits the fragment. Outbound Activities use the Actor's persisted key and `signJsonLd`.

`adminSecret` is an optional server-local secret used only for `FctpServer` admin authorization. It is not used as a federation key and no admin operation routes are installed.

## Changed files and exports

- `apps/test-authority/src/bootstrap.ts`: exports `createAuthority`, `CreateAuthorityOptions`, `Authority`, `AuthorityRole`, and `AuthorityActors`.
- `packages/identity/src/index.ts`: adds an optional explicit key ID to `generateActorKey` and exports `importActorKey`, backed by the existing Digital Bazaar `Ed25519Multikey.from` API. This is the only identity-library addition for standards-based key import; no dependency or configuration was added.
- `tests/authority-bootstrap.test.ts`: persistent key/mode check, Actor and WebFinger HTTP discovery, fragment-key document retrieval, distinct inbox dispatch, and outbound proof verification.
- `docs/handoffs/authority-bootstrap.md`: this handoff.

## Verification

Commands were run sequentially:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. The supervisor-provided root TypeScript references do not include `apps/`; the test and ESLint cover the bootstrap path. |
| `npx tsx --test tests/authority-bootstrap.test.ts` | Passed: 1 test. |
| `npx eslint apps/test-authority/src/bootstrap.ts tests/authority-bootstrap.test.ts` | Passed. |

The first focused test attempt exposed a test cleanup double-close (`ERR_SERVER_NOT_RUNNING`); cleanup now uses the authority's idempotent lifecycle entry point. An initial lint run also found unused imports/bindings, which were removed before the passing run.

## Checkpoint

The local authority can be restarted with the same keys, public Actor/key documents can be retrieved and discovered, Activity delivery dispatch is scoped to the addressed Actor, and outbound envelopes verify against the published public key. The helper API is ready for downstream Home and Registry work. No later workflow unit was started.
