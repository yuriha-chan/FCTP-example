# Browser Player authoring checkpoint

## Scope and fixture

- `tests/browser-authoring.test.ts` uses the compiled browser harness, built Client server, real Authority/A/B app factories, isolated temporary stores, and four dynamically selected loopback ports. Client configuration includes all three service origins and actors.
- Player-2 and Player-3 tokens are provisioned through Authority's `/local/home/issue` API. Session setup and authoring use rendered browser controls; vessel references come from `authority.ids.vessels`.
- The test creates an Asset containing literal inert HTML and a linked fractional-mass Variety with a complete Area, then verifies the AssetGrant's `grantee`, asset, and variety fields. It independently verifies signed retrieved objects and archived Create Activities, including key attribution.
- Checks include exact visible literal text, absence of a rendered standalone injected heading, exact public `text/plain` media fetch, rollback after invalid production JSON, isolated drafts/catalog/options on Player switch, hidden admin authoring controls, and continued public object fetchability.
- Cleanup closes sessions and Client, B, A, and Authority services before removing the isolated store directory.

## Changed files

- `tests/browser-authoring.test.ts`
- `docs/handoffs/browser-authoring.md`
- `docs/memos/browser-authoring.json`

## Verification

- `npm run build` — passed.
- `npm run typecheck:tests` — passed.
- `npx tsx --test tests/browser-authoring.test.ts` — passed (1 test).
- `npx tsx --test tests/player-authoring.test.ts` — passed (1 test).
- `npx eslint tests/browser-authoring.test.ts apps/client/src/authoring.ts` — passed.

## Findings

- `state.outboxArchive` is the persisted activity archive; there is no `state.archive` field.
- `AssetGrant` identifies the recipient with `grantee`; the `holder` assertion applies to Asset and Variety objects.
- Production Areas must contain `id`, `name`, and `territory`; the expected Production preserves the full Area.
- Name-field refs are selected by occurrence inside the Player creations section. Multiline Text field refs resolve through their following rendered ref token.
- Outbox activities and retrieved published objects are independently proof-verified. The grant and both referenced public objects remain fetchable.

## Boundary

- No live service/store, gameplay operation, or Territory tick was used; no commit was created.
