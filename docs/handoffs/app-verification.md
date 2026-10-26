# Integrated application verification

## Scope and API facts

- `createAuthorityApp(options)` returns `{ authority, home, registry, ids }`. With no `adoption` option, a new Registry state starts with adoption enabled, while an existing persisted Registry adoption setting is retained. An explicit boolean option overrides the saved setting.
- `createPolicyApp(options)` returns `{ host, territory, ids }`. Its IDs expose local ports/routes/areas/map/varieties/assets; its production contract and authorization are Territory A-specific.
- `createSimulationApp(options)` returns `{ host, territory, ids }`. Its local ports/routes/assets IDs are arrays; `ids.varieties.importedMetal` refers to the policy Territory's metal URI. Unload cargo input is a `CargoManifest` with an `entries` array.
- Factories do not listen or start workers; callers own server lifecycle.

## Changed files

- `apps/test-authority/src/app.ts`: initialize the Registry with `const` after `createAuthority` completes; the verifier callback resolves it when invoked later.
- `apps/territory-policy/src/app.ts`: mark the configured first public port as present.
- `apps/territory-sim/src/app.ts`: access the initialized host through `hostRef.current`, name local asset resources before assembling the assets array, and narrow/validate cargo quantity fields before mapping them to vessel cargo.
- `tests/authority-app.test.ts`: send the required JSON body for token issuance and provide the fake destination Actor during Registry entry resolution.
- `tests/sim-app.test.ts`: assert the Asset document is public and check unauthenticated/invalid-token rejection and Player access on its plain-text media resource.
- `docs/handoffs/app-verification.md` and `docs/memos/app-verification.json`: checkpoint record.

## Verification

- Command: `timeout 180s npm test`.
- Result after the authority `prefer-const` repair: build passed, test-source typechecking passed, ESLint passed, and runtime tests ran; 44 passed and 2 failed due to the test fixtures described above.
- Focused command: `npx tsx --test tests/authority-app.test.ts tests/sim-app.test.ts`.
- Focused result after fixture repairs: 3 passed, 0 failed.
- The focused simulation test exercises protected text media, token declaration, and Player/administrator role authorization over HTTP.
- No UI test or commit was performed.
