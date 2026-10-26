# Home workflow handoff

## Scope and behavior

Implemented the Home token and local resource-proxy workflow. The service stores its only Player's Home state in `server.store.domain.home`, isolated from Registry state. The native token is 32 cryptographically random bytes encoded as unpadded base64 and remains in Home's local snapshot and issuance/rotation responses. No token contents are logged. Public service operations are serialized per Player across state reads, async derivation/signing, network resource access, and store commits. A rejected operation does not poison the queue; subsequent operations continue.

Diplomatic tokens use the shared `deriveDiplomaticToken` implementation with the exact Resource Server Actor ID. Token digests and revocations are sent as ActivityStreams `Create` objects using `authority.server.publish` or `commit`, so outbound messages are signed with the persisted Home key. Resources first recorded by digest or revoke are tracked per Actor; rotation increments each recorded resource's revision and enqueues its new digest in the same store commit as the token change. Revocation increments that resource's revision and retains its revision state. The persisted per-resource revision is the greatest revision and is never reset on revoke.

`installHome(authority, options)` returns `HomeService` with `issueNativeToken`, `rotateNativeToken`, `requestDigest`, `revoke`, `deriveToken`, `getResource`, and a shared `ResourceClient` at `resources`. Player Actor selection defaults to the test authority's Player Actor and is constrained to that one configured local Player. The Home service does not enroll the Player with any Territory.

Local routes are installed beneath `/local/home`:

| Method and path | Authentication | Behavior |
| --- | --- | --- |
| `GET /local/home/endpoints` | None | Lists the local Home operations. |
| `POST /local/home/issue` | `authority.server.checkAdmin` | Issues and returns the local Player's native token. |
| `POST /local/home/rotate` | `authority.server.checkAdmin` | Rotates the native token and publishes digests to all recorded Resource Actors. |
| `POST /local/home/revoke` | `authority.server.checkAdmin` | Body `{ "resourceActor": "<Actor URI>" }`; publishes a revision-increasing revoke. |
| `POST /local/home/digest-request` | `authority.server.checkAdmin` | Body `{ "resourceActor": "<Actor URI>" }`; resolves its Actor document and publishes a digest. |
| `GET /local/home/proxy?uri=<URI>&resourceActor=<Actor URI>` | Player native token as Bearer credential | Uses `ResourceClient` to GET the exact supplied URI using the derived diplomatic bearer token; forwards resource authorization status. |

Admin routes use the server-specific secret provided to `createAuthority` through its existing `checkAdmin` path. Proxy authentication only recognizes the configured Player's local native credential. It does not treat administrator credentials as resource credentials or bypass the Resource Server's authorization decision. Direct and proxy requests use the shared ResourceClient request contract and the proxy preserves the upstream HTTP authorization status.

## Changed files and exports

- `apps/test-authority/src/home.ts`: exports `installHome`, `HomeOptions`, and `HomeService`.
- `tests/home.test.ts`: verifies native-token length, resource-scoped derivation, persisted revisions, rotation and revoke, signed Activity handling with the real inbound proof verifier, direct/proxy allow and deny parity against a running resource authority, and overlapping digest/rotation/revoke operations with correct final credential state and queue recovery after rejection.
- `docs/handoffs/home.md`: this handoff.
- `docs/memos/home-revision.json`: reusable reason, invariant, API, and verification record for per-Player Home operation serialization.

## Verification

Final focused commands were run after the implementation changes:

| Command | Result |
| --- | --- |
| `npx tsx --test tests/home.test.ts` | Passed: 1 test. The test includes real Home Activity signing and Resource Server proof verification. |
| `npx eslint apps/test-authority/src/home.ts tests/home.test.ts` | Passed with no output. |
| `npm run typecheck` (`tsc -b --pretty false`) | Passed. Uses the root project references, including `apps/test-authority` and its source; no Home diagnostics. |
| `npm run typecheck:tests` (`tsc -p tests/tsconfig.json --pretty false`) | Failed on unrelated `tests/sim-domain.test.ts:136` TS7053: string cannot index the inferred closed variety-key object. No Home/test-home diagnostics were reported. |

The focused test confirms that calls issued concurrently are applied in queue order, revisions progress from 4 through 6 with no reuse or lost update, revocation invalidates the current credential, and a later digest at revision 7 restores only the current credential. A rejected duplicate issuance is followed by successful operations, confirming queue recovery.

## Checkpoint

Home token issuance, persistence, scoped derivation, serialized rotation/revoke revisions, signed delivery and local proxy authorization are implemented. Territory enrollment remains an explicit later factory integration. Work stops at the Home checkpoint.
