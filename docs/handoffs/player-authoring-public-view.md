# Player authoring public-view diagnosis

## Finding

- The existing assertion at `tests/browser-authoring.test.ts:212` is a valid rendered-DOM criterion. It follows the `Published Player creations` button produced after resolving Player-2 and requires the rendered result to contain each authored object ID.
- In the single focused run, the first asset ID checked was `http://127.0.0.1:34005/objects/players/player-2/c10bf5e391b48164f2a438da99b02b85`. The visible page showed `Error: Failed to execute 'fetch' on 'Window': Illegal invocation`; the resource result also showed that exact error. No fetched collection JSON or object IDs appeared in the rendered view.
- This is a client-side fetch invocation failure, not evidence of missing collection entries. `appendResource` invokes `sdk.get` on button click. `FctpClient` gives its fetch function to `ResourceClient`, whose `get` calls it as `this.fetcher(...)`. The receiver is then the `ResourceClient` instance, which causes the Window fetch implementation to reject the invocation with `Illegal invocation`. Actor resolution had already succeeded through its separate fetch path.
- The public collection route in `apps/test-authority/src/authoring.ts` returns HTTP 200 with an ActivityStreams `OrderedCollection`; `orderedItems` contains the catalog Asset, Variety, and AssetGrant objects. Before the DOM step, the existing test independently fetched that route and observed `orderedItems.length === 3`, but did not inspect those IDs. During the focused run, the button's failed fetch prevented an actual collection response from reaching the rendered page. The direct route result must not replace the DOM assertion.
- The assertion is not a typo: it identifies the expected public objects and uses the correct rendered form interaction. The minimal semantic implementation fix recommendation is to invoke the resource fetcher with the global/Window receiver (or bind it when constructing `ResourceClient`), then retain this DOM assertion. No implementation change was made here.

## Resolution

- The supervisor applied the recommended fix in `packages/resources/src/index.ts`: `ResourceClient.get` copies its stored fetcher to a local variable and invokes that variable, so browser `fetch` does not receive the `ResourceClient` instance as its receiver.
- The rendered-DOM assertion was preserved. The focused browser authoring test then passed, including the public `Published Player creations` click, and the final `timeout 180s npm test` gate passed all 81 runtime tests.

## Verification

- Added the current markdown to the existing assertion's failure message without changing or weakening its checks.
- Ran exactly once: `npx tsx --test tests/browser-authoring.test.ts` — failed at the intended assertion after 1 test; the diagnostic above was captured. This executed against the existing compiled bundle and did not rebuild it.
- No build, broad gate, second test run, or implementation edit was performed.

## Changed files and boundary

- `tests/browser-authoring.test.ts`: diagnostic message only.
- `docs/handoffs/player-authoring-public-view.md`: diagnosis and minimal fix recommendation.
- `docs/memos/player-authoring-public-view.json`: machine-readable diagnosis and run result.
- No exported API changed. No live service, roleplay operation, or Territory tick was used; no commit was created.
