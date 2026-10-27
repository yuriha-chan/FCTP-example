# Player Asset and Variety authoring contract

## Goal and decisions

Players create persistent text/ASCII Assets and Variety definitions through the actual browser UI, including its DOM-to-text harness. This is a local experimental authoring API, not an FCTP-standard Client operation. Protocol sections 4–6 govern published objects. Player identity comes from Home native-token authentication, never a caller-supplied holder/creator or administrator credential. Authoring does not install Territory recipes or mint cargo.

The shared Authority already hosts all Player Actors and keys. Reuse it, its Home authentication, persistent store and generic server publication. Do not create another host, credential system, crypto loader or economic engine. Originals and live roleplay remain untouched; tests use isolated origins and stores.

## HTTP and persisted representation

- `GET /local/authoring`: requires valid native Player token; returns `{ actor, assets: Asset[], varieties: Variety[], grants: AssetGrant[] }` scoped to the authenticated Player. No other Player's private session or credentials. `Cache-Control: no-store` on local endpoints.
- `POST /local/authoring/assets`: `{ name: string, text: string }`; nonempty name, text may contain ASCII/newlines. Returns HTTP 201 `{ asset, activity }`. Server assigns fresh absolute own-origin IDs, `type: Asset`, `creator: [playerId]`, `holder: playerId`, and a single local `text/plain` Media reference. Persist text and return it through public GET at that exact Media URI with `Content-Type: text/plain; charset=utf-8`. Treat all text as inert text, never HTML.
- `POST /local/authoring/varieties`: `{ name: string, mass: number, version: string, asset?: URI, production?: Production[] }`; mass finite and positive, nonempty name/version. Returns HTTP 201 `{ variety, activity, grant? }`. Server assigns fresh ID, `type: Variety`, `holder: playerId`. Use protocol runtime validation for Production, preserving its data rather than inventing execution semantics. Optional asset must identify an Asset authored and held by this same Player in the local catalog; reject unsupported foreign/unowned asset use with 403 before mutation. A successful reference creates and publishes an `AssetGrant` for that Asset/Variety/holder in the same commit and returns it as `grant`. No grant required when asset omitted.
- Invalid/missing native token returns 401. An admin secret is not a Player token. Malformed JSON/invalid inputs return 400 without mutation. Own object IDs/creator/holder/proof are server-controlled; reject attempts to supply them rather than silently impersonating ownership.
- Persist under `domain.authoring` keyed by Player; store signed objects in `state.objects` for existing public GET, and media text in a separately indexed persisted authoring record. Restart must retain catalog, media and outbox. New objects use new IDs; no update/delete API in this task.
- Objects include ActivityStreams+FCTP contexts and independent actual `eddsa-rdfc-2022` proofs. Player-signed `Create` Activities appear in the existing public Player Outbox even with no subscribers. No fake self-recipient/network delivery. Absence of subscribers is explicit: publish to Outbox, do not claim remote delivery or Creative Assets profile completeness.
- Public collection URI `/objects/players/<player-name>/creations` lists that Player's published objects; expose it in Player Actor `creations` as a documented local discovery extension. It is not a required FCTP field. Collection resources and objects remain fetchable after restart.
- `/local/info` advertises authoring endpoints. Extend returned AuthorityApp with `authoring` service for focused composition/tests, preserving existing app fields.

## Generic publication unit

Extend `FctpServer.commit` compatibly with an optional third `publications` array of `{ actorId, object, activityId }`. It assembles and signs local `Create` Activities through the configured signer, then atomically applies domain mutation, stores objects and archives Activities without enqueuing delivery. Existing outgoing messages retain current behavior. Reuse archive/ID conflict logic rather than introduce a second outbox store. Preserve immutability and transaction rollback. This small shared primitive must be completed before the Authority unit relies on it.

## Browser contract

- Player-only section titled `Player creations`; form `asset-authoring-form` labelled `Create text Asset`, inputs `name`, textarea `text`, submit label `Create Asset`.
- Form `variety-authoring-form` labelled `Create Variety`: `name`, `mass` (number, step any, >0), `version` (default `1.0`), optional `asset` select populated from own catalog plus None, `production` textarea default `[]`; submit `Create Variety`.
- Button `Refresh my creations`; output `authoring-result`, catalog `authoring-catalog`. Show actual created IDs, holder, Asset text/media and Variety/Production details using safe textContent. Add navigable fetch/view links/buttons using existing resource helpers where appropriate.
- Use native token to configured Authority origin, existing pending/error/busy handling, clear private authoring outputs and owned Asset choices on session switch, and refresh own catalog after success. Do not clear submitted text on failure. Administrator panels cannot author for Players.
- Implement authoring UI logic in a small dedicated browser module with injected session/request/task helpers; integrate with main.ts rather than enlarge an unrelated resource/game abstraction. No gameplay HTTP added to harness or run CLI.

## Bounded units and verification

1. Shared atomic local publication: source/server tests/handoff only.
2. Authority authoring routes/service/context terms and focused HTTP, actual-proof, persistence and Player-isolation tests.
3. Browser authoring module/forms and focused DOM-harness test: nondefault Player creates Asset and linked Variety through visible forms; independently verify retrieved proof and grant; switch Player and show isolated authoring state; previous public objects remain fetchable. Headless focused UI checks are explicitly user-authorized for this browser-backed work.
4. Supervisor semantic review followed by delegated build/test-source typecheck/ESLint/focused checks and single integrated test gate; update README/API/client walkthrough/conventions/limitations with actual verified behavior.

Instruction split: read `docs/subagent-instructions.md` for subagent obligations; supervisor orchestration remains in `docs/supervisor-instructions.md`. Fresh bounded General units receive this file by @ mention. Mechanical checks belong to subagents; supervisor reviews semantics and continues across checkpoints.
