# Player authoring client checkpoint

## Client contract and integration

- `apps/client/src/authoring.ts` exports `setupAuthoring(dependencies)`, returning `sessionChanged()` and `refresh()`.
- Dependencies are `authorityOrigin`, a `getSession()` accessor, generic `request(origin, path, options)`, the existing task wrapper, and `getPublicResource(uri)`. The session accessor exposes only role, Player URI, and the in-memory credential; request identity is never accepted from form data.
- `apps/client/src/main.ts` composes the module with configured-origin-checked `localRequest`, the shared `task` operation status/error wrapper, current session accessor, and `sdk.get(uri, { cache: false })`. Applying any session clears authoring form drafts, results, catalog, and Asset options. The section is Player-role scoped.
- `GET <configured Authority origin>/local/authoring` sends the current Player native token as Bearer and expects `{ actor, assets: object[], varieties: object[], grants: object[] }`.
- Asset creation sends `POST /local/authoring/assets` with `{ name, text }`; Variety creation sends `POST /local/authoring/varieties` with `{ name, mass, version, asset?, production }`. Mass accepts any positive finite number, including fractions. Production defaults to `[]`, is checked as a JSON array, and is explicitly labelled descriptive/not installed.
- Successful writes use the shared task wrapper and refresh the own catalog. Failed submissions leave entered values intact. Catalog object fetch and public text-media view controls display fetched content through `textContent`/`pre.textContent`; no HTML insertion is used.

## Changed files

- `apps/client/index.html`: Player-only `Player creations` section and Asset/Variety forms, catalog and output regions.
- `apps/client/src/authoring.ts`: injected authoring module, session reset, endpoint requests, catalog rendering, and public object/text view controls.
- `apps/client/src/main.ts`: module composition and session-switch clearing.
- `docs/handoffs/player-authoring-client.md`: this integration handoff.

## Verification and boundary

- `npx tsc -p apps/client/tsconfig.json --pretty false` — passed; browser client TypeScript project, including `main.ts` and `authoring.ts`.
- `npx eslint apps/client/src/main.ts apps/client/src/authoring.ts` — passed; both client TypeScript sources included.
- No browser/DOM test, gameplay fetch test, live service run, role operation, tick, or configuration change was performed. UI test remains deferred until the server unit is ready.
