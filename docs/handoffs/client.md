# Browser client handoff

## Scope and behavior

The browser app under `apps/client/` uses the launcher `/config.json` document (`origins` and `actors`) and falls back to loopback ports 4100–4102 when running without launcher configuration. The client contains no Node/server-base imports. It uses `FctpClient`, the shared Fetch `ResourceClient`, diplomatic-token derivation, Actor/WebFinger resolution, cargo comparison, map selection and allowlisted proof verification.

The page supports Actor URI and WebFinger lookup; linked Territory port, route, area and listing browsing; id-only and embedded reference resolution; Variety/Asset documents and their text media; the single supported ASCII map representation; and explicit unsupported-format errors. Resource GET offers direct and Home-proxy paths and displays HTTP authorization/not-found failures. Native token and all administrator credentials are held only in page state/form controls; no browser storage is used. Authority credentials are separate from A and B administrator credentials. Default local credential placeholders are documented in the page.

The authority panel issues/rotates the native token and requests/revokes a resource digest. Registry controls send entry/departure requests, switch event adoption and refresh the declared vessel cargo, requests, events and ExitEvent references. The ExitEvent inspector fetches the evidence, resolves its Territory and proof key, uses the shared allowlisted identity verification utilities, and reports proof cryptography, key attribution, expected issuer and request binding separately. Registry-declared cargo and ExitEvent cargo are shown side by side with a descriptive shared cargo difference; these facts do not imply Territory trust or a Territory decision.

Territory A controls use its local policy/admission, mine, manufacture, warehouse/port transfer, load/unload and state routes. Territory B controls separately use its facilities/tick, mine, native/imported manufacture, rich-manifest load/unload and state routes. B load/unload uses `entryRequest`, never a vessel URI. B operations report scheduled jobs and refresh state; UI text does not claim scheduled work has completed. The page describes the manual A production → transfer/load → departure/ExitEvent → B entry → tick/berth → unload/tick → imported manufacture/tick → load/tick → departure/ExitEvent observation path.

## Files and exported APIs

- `apps/client/index.html`: all browse, authentication, Registry, evidence and separate A/B demo controls.
- `apps/client/styles.css`: responsive readable layout.
- `apps/client/src/client.ts`: exports `FctpClient` instance `sdk`, `ClientConfig`, `fallbackConfig`, `loadConfig`, Actor/reference/Collection/Territory resolution helpers, authenticated direct/proxy retrieval, text/map retrieval, ExitEvent verification, cargo-manifest validation and local experimental API helper.
- `apps/client/src/main.ts`: DOM orchestration and server-specific form adapters.
- `apps/client/tsconfig.json`: strict browser TypeScript project with only browser-compatible shared-package references.
- `docs/handoffs/client.md`: this handoff.

## Bounded client repair checkpoint

The A factory confirms `/local/info` provides the `ids` record and `/local/state` returns `{ state, admission, decisions }`; refresh uses only state for policy/admission and preserves the separately fetched info record for IDs. B `/local/info` likewise provides IDs, while `/local/state` returns the simulation state; refresh no longer changes the info record or rewrites the cargo form. The Registry destination selector takes Territory, first port and first route from the selected factory's `/local/info`. Initial A transfer/cargo varieties use its metal URI, and B's initial cargo is set once from B info.

All `data-action` handlers now run through the shared task error boundary and their explicit action-to-output map. Discovery awaits resource rendering. Resource rendering keeps A/B selection buttons in place, displays listing/resource retrieval errors locally and continues to other resource sections. B's published Actor variety and asset URI arrays are rendered through the same lists as A.

`verifyExit` now accepts the expected current Registry vessel and Registry IDs plus an optional injected fetcher. It fetches the ExitEvent, Territory Actor and proof key through that fetcher; crypto and key attribution are evaluated independently of Registry binding. Binding checks the indexed EntryRequest's exact ID, its vessel ID and registry against current Registry context, and destination Territory against the ExitEvent. Missing request binding reports false, and expected issuer is `unknown` when the request destination context is unavailable. Added `tests/client-data.test.ts` with a real generated signing key and signed ExitEvent fixture, injected HTTP fetch, and correct/wrong Territory, request, unknown request and vessel cases.

## Verification and findings

| Command | Result |
| --- | --- |
| `npx tsc -p apps/client/tsconfig.json --pretty false` | Passed with no diagnostics; browser app source included. |
| `npx tsc -p tests/tsconfig.json --pretty false` | Passed with no diagnostics; focused helper test typechecked. |
| `npx tsx --test tests/client-data.test.ts` | Passed: 1 test, 1 pass, 0 failures. Exercises a real signed fixture and injected fetch. |
| `npx eslint apps/client tests/client-data.test.ts` | Passed with no output; app and focused helper test included. |
| `git diff --check` | Passed with no output. |
| UI tests | Not run, per assignment. |
| Bundle | Not run; launcher bundle gate is separate. |

Changed files: `apps/client/index.html`, `apps/client/src/client.ts`, `apps/client/src/main.ts`, `tests/client-data.test.ts`, and this handoff. Exported client API change: `verifyExit(uri, expectedVessel, expectedRegistry, registryRequests, fetcher?)`. The optional fetcher supports deterministic HTTP-level helper verification. No Node imports were added to browser client source. No blockers; returned at the client repair checkpoint.

The updated app-layer contract and implementation handoff select `https://fctp.example/formats/ascii`, and Territory A/B source descriptors now use it. `docs/implementation-conventions.md` still contains the former `https://fctp.example/map/ascii` URI at lines 22 and 37; that shared document is outside this unit and should be corrected by the supervisor. The client intentionally supports only the selected `formats/ascii` URI and displays unsupported descriptors as HTTP 406-style resource errors.

No UI testing was performed. Browser UI testing remains for the user/supervisor. Client unit checkpoint is complete; no subsequent unit was started and no commit was made.
