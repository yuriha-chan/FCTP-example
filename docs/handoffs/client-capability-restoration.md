# Client capability restoration handoff

## Scope and changed paths

- `apps/client/src/main.ts`: restored configurable Territory operations, session-scoped cargo gating, administrator refresh readiness, advanced-object selection, safe common-field updates, and nonempty numeric validation.
- `apps/client/index.html`: restored labeled collapsible A/B custom operation sections and structured/advanced administrator modes while retaining the readable discovery workflow.
- `tests/browser-client-controls.test.ts`: added rendered-browser coverage for disabled and rejected pre-refresh administration, full policy/admission updates, preservation during common updates, session invalidation, count-based A mining, and unavailable cargo controls without a local berth.
- `docs/handoffs/client-capability-restoration.md`: this handoff.

Existing work in `apps/client/src/authoring.ts`, authoring/Production markup, presentation code, server contracts, and other tests was preserved. No exported API or service operation was added.

## Semantics

- Custom controls submit the existing A and B local API contracts. A counts are immediate; B responses are reported as scheduled work with later completion observable by tick and refresh.
- A cargo controls remain disabled until a successful Player refresh reports the session vessel's persisted visit, matching possessor, not departed, and local vessel state. Requests use the session vessel, not the editable form value.
- B cargo controls remain disabled until a successful Player refresh finds an accepted, not-exited visit whose `request.vessel.id` and possessor match the session, and whose simulation vessel is berthed. The current visit's EntryRequest is populated from that state and the mutation uses the captured refreshed ID rather than form contents. Server-side checks remain authoritative.
- Each policy/admission advanced JSON mode submits its complete object as the sole source for that endpoint. Common updates start from refreshed snapshots, retain other recipe permits, Variety policies, acceptance lists and undisplayed public ports, and change only represented settings.
- Policy and facilities mutations require a successful refresh in the current matching administrator session, in both disabled-button state and handler checks. Session changes clear snapshots, readiness, administrator drafts, and scoped cargo references/manifests. Blank numeric fields reject rather than becoming zero.

## Verification

Commands run from `/app`:

| Command | Result |
| --- | --- |
| `npm run build` | Passed; app/client build completed. |
| `npm run typecheck:tests` | Passed; test sources and client sources included. |
| `npx eslint apps/client/src/main.ts tests/browser-client-controls.test.ts` | Passed; no diagnostics. |
| `npx tsx --test tests/browser-client-controls.test.ts` | Passed, 1/1 rendered-browser test using the provisioned pinned Playwright runtime. |
| `git diff --check` | Passed; no whitespace errors. |

The full verification gate was not run. No world was launched and no commit was created.

## Remaining coverage boundary

The focused test verifies cargo remains unavailable before and after refresh without a persisted berth. Server-side revalidation remains covered by existing Territory contracts; this focused test does not create a berth to exercise enabling the custom cargo controls.
