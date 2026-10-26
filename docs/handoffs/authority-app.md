# Authority app handoff

## Scope and API

`apps/test-authority/src/app.ts` exports `createAuthorityApp(options)` and its option, result, and ID types. The factory accepts `origin`, `storeFile`, optional `keyFile`, `adminSecret`, optional `fetcher`, and optional `adoption` (default `true`). It composes `createAuthority`, `installHome`, and `installRegistry`, returns `{ authority, home, registry, ids }`, and does not start listening or workers.

`ids.actor` contains the Registry, Home, and Player Actor IDs. `ids.vessel` identifies `${origin}/objects/vessels/demo`; the Vessel is stored in `store.objects` when the app is constructed, making it retrievable before any entry request. `/local/info` is public and reports authority kind, Actor/resource IDs, and local endpoint descriptions without credentials. Home issuance and rotation remain available only through the existing authenticated Home routes. Registry's existing adoption route is retained; factory adoption starts enabled by default and can be selected with the `adoption` option.

The authority inbound verifier delegates its expected-issuer decision to the installed Registry closure. Until Registry installation, that closure returns no expected issuer; it never accepts the sender as a fallback. No Home or Registry HTTP API was duplicated.

## Changed files

- `apps/test-authority/src/app.ts`: authority factory and public local info route.
- `tests/authority-app.test.ts`: focused real-HTTP integration test for Actor discovery, info, authenticated issuance, initial Vessel retrieval, and signed Registry entry publication.
- `docs/handoffs/authority-app.md`: this handoff.

## Verification

Checks were attempted sequentially:

| Command | Result |
| --- | --- |
| `npm run build` | First run passed. After the focused-test cleanup correction, the sequential rerun failed on unrelated diagnostics in `apps/territory-policy/src/app.ts:102-103` (TS2375 and TS2322). |
| `npm run typecheck:tests` | Passed before the cleanup correction; the correction only removed a redundant explicit listener close because `authority.close()` already closes the tracked listener. |
| `npx tsx --test tests/authority-app.test.ts` | Initial run failed during cleanup with `ERR_SERVER_NOT_RUNNING` due to closing the listener both directly and through `authority.close()`. The duplicate close was removed. The test was not rerun because the subsequent build failed. |
| ESLint | Not reached after the build failure. |

The integration assertions were therefore not confirmed after the cleanup adjustment. No UI test or commit was performed. Work stops at the authority factory checkpoint.
