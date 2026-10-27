# Non-owner Asset text readability

## Scope

- Unit: client readability for text Asset media.
- Owned production paths: `apps/client/src/main.ts`, `apps/client/src/client.ts`.
- Focused browser test: `tests/browser-authoring.test.ts`.
- No Authority publication route, object, collection, Outbox, or media semantics changed.

## Implementation

- Added `readTextPublicThenAuthenticated(uri, actorId, nativeToken?)` in `apps/client/src/client.ts`.
  - Performs the unauthenticated public `GET` with `Accept: text/plain` first.
  - Falls back to the existing Actor-scoped diplomatic-token `readText` only when the public response is 401 or 403 and a native token is available.
  - 404 and all other non-OK statuses throw the existing `ResourceError` without attempting an authenticated read.
- `apps/client/src/main.ts` now uses that helper for every text media control, including Territory text resources, map text, and Player Asset media.
- The rendered public `Published Player creations` action keeps its existing label and JSON collection result. When its public collection is loaded, the client also appends `Asset text <name>` controls for inline Asset media entries in `orderedItems`/`items`.
  - This provides the rendered non-owner path to a Player-authored Asset, because test-Authority Player Actors publish `creations` but do not link an `assets` array on the Actor document.
  - Repeated collection loads replace prior collection-media controls rather than duplicating them.
- All rendering remains `textContent`-based; no HTML insertion was introduced.

## Focused browser coverage

- After switching the same browser session to Player-3, the test resolves Player-2's Actor and loads Player-2's public creations collection.
- Player-3 clicks the rendered `Asset text Literal text Asset:` control and observes the exact literal source text, including its injected-HTML-shaped payload, with no standalone injected heading rendered.
- The test then mutates the test-only Authority domain copy of the Asset media URL to a missing route, re-resolves Player-2, and clicks the rendered media control. The rendered result surfaces `Resource request failed: HTTP 404`; it is not hidden by the private authoring catalog.
- Existing checks for public collections, public object fetchability, authoring isolation, signatures, and Outbox publication remain in place.

## Verification

Commands run sequentially, including app and test sources:

1. `npm run build` — passed (TypeScript project build plus browser bundle).
2. `npm run typecheck:tests` — passed (tests and browser client project).
3. `npx tsx --test tests/browser-authoring.test.ts` — passed, 1 test, 0 failures.
4. `npx eslint apps/client/src/main.ts apps/client/src/client.ts tests/browser-authoring.test.ts` — passed with no diagnostics.

No failed command required a correction. No broad/full test gate was run; the assignment requested focused checks.

## Findings and boundaries

- The Authority already serves Player media as public `text/plain`; the client was choosing authenticated text read whenever a session token existed.
- Player Actors expose the public `creations` collection rather than an Actor `assets` link, so the collection is the natural rendered entry point for another Player's Assets.
- The public collection response itself is unchanged; the client only adds media controls after loading it.
- The missing-resource case is induced only in the test store copy; no production route or publication behavior was changed.
- The working tree also contained unrelated Territory A policy files and policy tests modified by other work. They were not edited here; the workspace build, test-source typecheck, and focused browser test ran with those changes present.
- No commit was created. No browser UI acceptance beyond the automated rendered harness is claimed.
