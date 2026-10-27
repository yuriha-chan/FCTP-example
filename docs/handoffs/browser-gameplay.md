# Browser gameplay integration checkpoint

## Acceptance

`tests/browser-gameplay.test.ts` composes one real `createAuthorityApp` configured for five Players, both `createPolicyApp` and `createSimulationApp`, and the shared `startClientServer` serving the built client bundle. Services use four dynamically selected free loopback ports and an isolated temporary store directory. Browser sessions import the compiled `../dist/apps/browser-harness/index.js` runtime and use actual visible HTML controls; no page application calls or gameplay fetches are made by the test. The only API setup operations issue Player-2/Player-3 native credentials and deliver signed Home token digests.

The browser integration verifies:

- Non-default Player-2 login selects that exact vessel, clears/masks the credential, and a separate Player-3 browser context sees only Player-3 Registry state.
- A visibly unavailable manufacture reason and disabled load action remain unavailable after unrelated UI operations.
- A form mines two ore, then advertised A actions manufacture metal and transfer it to port; server-owned state confirms consumed ore, produced port metal, and no vessel state mutated before entry.
- A-advertised entry targets the configured Authority Registry with Player-2's selected vessel. Bounded service pumping/refresh observes A's accepted active visit before loading through the UI; state confirms exact vessel cargo and no Player-3 cargo change.
- Registry discovery advertises departure for the recorded current A berth, targets Authority, includes the selected vessel and A, and does not target B. A's own advertised departure action is then submitted through the browser.
- A Registry-recorded A ExitEvent is mandatory within a 12-second bounded poll. Timeout fails with redacted Registry location, evidence, pending-request and event-type state plus A visit/departure/cargo and decision/rejection details. The test independently verifies the exit proof, key attribution and expected issuer, then asserts the exact Registry-recorded berth EntryRequest, vessel and Registry identity, and exit cargo equality with the loaded vessel manifest. Completion is not inferred from click or delivery acknowledgement.

Every control action uses the fresh `TextView` returned by the preceding action. `refFor` requires exactly one label match and the discovery action references use their rendered `Run:` accessible names to distinguish them from duplicate headings.

## Changed files and APIs

- Added `tests/browser-gameplay.test.ts`; no production API changed.
- Added this handoff and `docs/memos/browser-gameplay.json`.

## Verification

Final ordered checks:

- `npm run build` — passed; TypeScript project builds, browser client compilation and built browser bundle.
- `npm run typecheck:tests` — passed; includes `tests/` and `apps/client/`.
- `npx tsx --test tests/browser-gameplay.test.ts` — passed; 1 test, 0 failed/cancelled/skipped/todo; Chromium launched and mandatory signed-exit acceptance passed; isolated integration duration about 9 seconds including fixture shutdown.
- `npx eslint tests/browser-gameplay.test.ts` — passed with no output.

`npm run typecheck:tests` passed, including `tests/` and `apps/client/`. The first typecheck after tightening assertions found an unknown fixture-state type and implicit event parameter; a local test-only cast corrected those issues, and the ordered final checks passed. No UI roleplay configuration, live stores, fixed ports, or ticks were used. No commit was made.

## Bounded gaps

- The integration does not exercise B gameplay, administrator UI, or all discovery action kinds.
