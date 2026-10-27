# Client resource access and identity presentation

The browser now reads resource URLs publicly before using credentials. JSON is parsed as JSON and text media is identified by `Content-Type`. Authenticated direct requests derive the diplomatic token only after a 401/403; the Home proxy remains available for its existing JSON-resource route. Public text is fetched directly first; protected text fallback is direct and is not claimed for the Home proxy. Audience selection uses exact Actor-linked resource provenance or a unique configured Actor on the resource origin. Unknown and ambiguous protected servers produce a player-readable error, and native credentials are not sent to resource URLs. The manual Actor override is under advanced technical options.

The shared identity display registry is populated from fetched named Actors/resources and renders names plus valid WebFinger handles in actor, resource, authoring, session, and Registry labels. Ordinary formatted output omits raw protocol URLs; DOM wrappers retain IDs, creator/holder links, Actor endpoints, and collection references in expandable technical-address details. Session changes clear learned access provenance.

Handle generation is limited to URLs with nonempty, period-free final path segments and protocol Actor roles; unsupported Actor IDs keep their names without a handle. Technical-address extraction includes production ingredient, tool, and location references while excluding authored text, opaque data, and proofs.

Link provenance is passed separately from the advanced manual override. URI edits clear that override, repeated media collections remove their complete button/address wrapper, and multiple Actor links to one URL remain ambiguous unless opened from a specific Actor or explicitly overridden.

Coverage includes pasted public Asset JSON and text URLs with no Actor override in the browser, public text handling, configured-server diplomatic-token fallback, proxy routing, ambiguous/unknown audiences, identity labels, and existing 404 visibility.

Evidence: `npm test` passed (build, test typecheck, ESLint, and 108 tests, including browser tests). After the handle-validation and production-address follow-ups, `npm run typecheck:tests`, `npm run lint`, and the focused client-data/presentation tests passed (13 tests); `git diff --check` passed.

No runtime, participant session, board, store, or credential operation was performed. The fresh-harbor world remains frozen at 12.
