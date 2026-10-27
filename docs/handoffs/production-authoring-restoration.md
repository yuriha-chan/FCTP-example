# Production authoring restoration handoff

## Changed paths

- `apps/client/index.html`: structured Production region now supports zero or multiple entries and explicitly selected advanced JSON mode.
- `apps/client/src/production-editor.ts`: builds each entry and its repeatable ingredient/location/yield rows with DOM APIs, collects either structured entries or advanced payloads, preserves mode drafts while toggling, and resets both modes on session change. Inactive mode controls are disabled so hidden URL fields do not block submission.
- `apps/client/src/authoring.ts`: uses the editor's selected Production payload while retaining the existing authoring/publication flow and presentation integration.
- `tests/browser-authoring.test.ts`: covers two structured Production entries, ingredient quantity, Area fields, tool, fractional and non-[0,1] probabilities, yield data, invalid data not publishing, advanced extension preservation, public retrieval/signatures, and draft clearing. The rendered form selector for the first yield count selects its second matching `Count` label, and the session-isolation fixture creates a Production entry before adding its ingredient draft.

## Semantics and concerns

- Advanced JSON is authoritative only when its mode is selected and is submitted unchanged for server validation. The structured editor omits ingredients, locations and tool unless entered; no recipe fields are invented.
- Probability is accepted as any finite number, matching `validateProduction`; it is not constrained to `[0,1]` or normalized. Quantity counts and duration use nonnegative safe integers. Data controls accept JSON objects only.
- Structured entries may omit ingredients, locations, and tool; each entry requires a kind, duration, and a yield list. Numeric count/duration fields reject blanks before conversion; probability permits finite fractional values with no added `[0,1]` restriction. Quantity and Area fields follow the protocol model's contracts; JSON data fields accept objects only.
- The focused browser test starts Chromium but fails at initial login: the rendered view exposes no control labelled `Role` (`refFor` in `tests/browser-authoring.test.ts:31`). Execution stops before Production assertions, so restoration semantics are not verified by this run.

## Verification

- `npm run build` — passed.
- `npm run typecheck:tests` — passed.
- `npx eslint apps/client/src/authoring.ts apps/client/src/production-editor.ts tests/browser-authoring.test.ts` — passed.
- `npx tsx --test tests/browser-authoring.test.ts` — failed at `login` (`tests/browser-authoring.test.ts:46`): expected control 1 labelled `Role`, found 0. The test setup corrections above were applied before this run. Browser execution reached the test, so the previously noted missing Chromium executable is no longer the blocker.

No world was launched or commit made. `presentation.ts` was not edited; its existing authoring integration remains preserved. Initial rendered-session control discovery is the blocker; report to supervisor before further test changes.
