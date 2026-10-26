# Message fixtures checkpoint

## Scope and changed files

- `tests/fixtures/messages/`: golden JSON for EntryRequest, EntryRejected, BerthingEvent, CargoOperationEvent, DepartureRequest, DepartureEvent, VoyageEvent, ExitEvent, TokenDigest, TokenRevoke, RouteRequest, RouteRequestApproval, RouteRequestDenial, Variety, CargoManifest, and a signed Create envelope containing the ExitEvent. `invalid.json` includes per-model malformed examples, plus a structurally valid ExitEvent whose proof has been tampered with. `territory-public-key.json` is the public Multikey document used to verify the signatures.
- `tests/message-fixtures.test.ts`: runtime schema checks, extension retention, invalid-case failures, independent ExitEvent/envelope proof verification after JSON roundtrip, and tampered-proof rejection.
- `scripts/generate-message-fixtures.mjs`: one-time fixture generator using `generateActorKey` and `signJsonLd`; it writes only the public key document and message JSON, not private key material. From the repository root, run `npm run build && node scripts/generate-message-fixtures.mjs` to regenerate. IDs and message content are fixed; generated key material/proofs are regenerated.
- `docs/handoffs/message-fixtures.md`: this checkpoint.

The RouteRequest golden has a genuine Data Integrity proof as well. Model validation intentionally checks proof shape; cryptographic proof validity is checked independently. ExitEvent and its containing Create each have distinct, independently verified proofs. Invalid proof tampering leaves the ExitEvent's model structure valid and fails cryptographic verification, rather than being misreported as a schema failure. Extension fields on EntryRequest and Variety survive validation.

No exported APIs, shared validators, protocol code, or application behavior changed.

## Verification

- `npm run build` — passed; package and application build.
- `node scripts/generate-message-fixtures.mjs` — passed after build.
- `npm run typecheck:tests` — passed; test and Client source typecheck.
- `npx tsx --test tests/message-fixtures.test.ts` — passed, 3 focused fixture tests.
- `npx eslint scripts/generate-message-fixtures.mjs tests/message-fixtures.test.ts` — passed.

The first focused test run exposed that TokenDigest/TokenRevoke have no `id` field and the initial generic invalid fixture did not invalidate them. Their invalid examples now use a negative revision. Validation assertions allow the model-specific `/revision` and CargoManifest `/entries` issue paths. Final focused tests pass.
