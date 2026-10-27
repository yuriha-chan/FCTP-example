# Player authoring server checkpoint

## Scope and exported API

- Implemented Authority-local Player Asset and Variety authoring in `apps/test-authority/src/authoring.ts`, composed by `createAuthorityApp`.
- `AuthorityApp.authoring` exposes `catalog(playerId)`, returning `{ actor, assets, varieties, grants }` scoped to a configured Player.
- Routes: `GET /local/authoring`; `POST /local/authoring/assets` with `{ name, text }`; `POST /local/authoring/varieties` with `{ name, mass, version, asset?, production? }`.
- Player Actor documents expose `creations: <origin>/objects/players/<name>/creations`; that public OrderedCollection includes the Player's Assets, Varieties and AssetGrants.
- Asset text is stored with the Player's authoring state and returned from the generated media URI as `text/plain; charset=utf-8`. The Asset itself has one `text/plain` media reference.
- New Asset, Variety and AssetGrant objects are independently signed with each Player's persisted Authority key. Their Create Activities are recorded through `FctpServer.commit`'s third `publications` parameter and the existing public Player Outbox, with no delivery queue item.
- Variety requests that reference an Asset require same-Player ownership and atomically publish a signed AssetGrant binding Asset, Variety and grantee. Production structures are runtime-validated and retained with extension data.
- Malformed/non-object/invalid requests return 400 only for recognized request validation errors; signing and persistence failures propagate. Production `location` entries use the protocol runtime `Area` validator, including `id`, `name`, and `territory`, while retaining extension data. Absent or invalid native Player authentication returns 401; non-owned Asset references return 403. Unknown top-level request keys are rejected. Local authoring responses use `Cache-Control: no-store`.

## Tests and limits

- `tests/player-authoring.test.ts` exercises five-Player isolation including empty other-Player catalogs, a non-default Player key, spoof rejection/rollback, malformed JSON and invalid production with no persisted object/outbox changes, cross-Player Asset-link rejection without mutation, text media retrieval, actual proof verification and tamper failure, AssetGrant binding, public collection and outbox, no queued delivery, restart persistence, and concurrent creation IDs.
- This server unit does not add browser UI, updates/deletes, remote delivery, Territory recipe installation, economic policy, or Creative Assets profile completeness. Public objects and collection remain local Authority resources.

## Verification

- `npm run build` — passed; includes TypeScript project builds and client build.
- `npm run typecheck:tests` — blocked by unrelated `tests/browser-authoring.test.ts` errors: app origin and player ID fixtures omit `policy` and `simulation`, and two reads reference nonexistent `state.archive`.
- Focused authoring test and scoped ESLint were not run after the failed typecheck, per the bounded verification instruction to stop after an unresolved command failure.
