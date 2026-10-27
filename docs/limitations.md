# Limitations and implementation status

## Implemented scope

The repository contains shared protocol, identity, resource, authentication, federation, server, and SDK packages; a test Home/Registry authority; distinct policy and simulation Territory applications; a browser client; and a loopback launcher. Focused acceptance and unit outcomes are cited in `spec-mapping.md` and individual handoffs. The integrated `timeout 180s npm test` gate exited 0 with build including the browser bundle, test-source typechecking, ESLint and all 85 runtime tests; `git diff --check` was clean. Evidence is in `docs/handoffs/next-run-verification.md`.

## Known limitations

- Persistence is `JsonSnapshotStore`: a single-process local JSON snapshot with serialized mutations and atomic temporary-file rename. It is not a multi-process database or distributed coordination layer.
- Demo services bind to `127.0.0.1` and use HTTP. This is a local-development exception; production FCTP resource URLs require HTTPS.
- Published maps are small ASCII/text resources and Assets are text-only. The client supports the documented local ASCII format and reports unsupported formats rather than rendering arbitrary media.
- The test authority is minimal: one configured Player, demo vessel, Home and Registry state, not a production identity or registry service.
- Player authoring is an experimental local Authority API. It creates immutable text Assets and Variety definitions, and may grant a same-Player Asset link; there is no update/delete API. Authenticated catalog scoping does not make published objects, public creations collection, Outbox Activities, or Asset media private. A non-owner can read published Asset text through the public `creations` collection; the client attempts the public media GET first and falls back to an authenticated read only on 401/403 with a native token. No remote subscriber delivery is claimed.
- Variety Production is descriptive validated data only; it is not automatically installed as a Territory rule and does not generate cargo. Authored Variety Production is neither executable nor portable to another Territory. Territory production remains Territory-specific.
- A's optional `varietyPortPolicy` is a local permit map keyed by canonical FCTP Variety URI. A missing entry allows load/unload, and `deny` rejects before mutation. It does not create a shadow Variety, alter the FCTP object, or install production; B has no equivalent mechanism.
- Territory operation routes under `/local/` are experimental application APIs, not standardized FCTP endpoints. Their payloads and A/B behavior are deliberately different.
- The browser retains native and administrator credentials only in page memory. Refreshing discards them; a new page session must issue or enter credentials again. A rotated native token also requires re-deriving/reissuing the relevant access state and delivering updated digests.
- Browser behavior has focused automated evidence for the Player authoring forms in an isolated compiled-browser harness, including non-owner public text reading. This does not establish broad UI coverage; the user should exercise the full browser workflow.
- Worker delivery is integrated in the launcher, while lower-level `processInbox`/`processOutbox` remain caller-driven APIs.
- `run/harbor/` contains a pre-game package for a possible roleplay session: advertisement, Arrivals guidance, an out-of-character developer desk, participant reflection guidance, and observer reporting guidance. `run/` is excluded from Git, no world was launched, and no run or tick is claimed.
- The JSON-LD context URI is provisional and resolved using a fixed local document loader. The adopted Activity envelope and ASCII map format are implementation conventions, not new FCTP requirements.

## Protocol features outside the MVP

The implementation targets the MVP path and does not claim every optional or complete profile feature in `protocol.txt` §§12.1–12.6. Full asset lifecycle/subscription and permission workflows, generalized route lifecycle/route requests, production-grade Registry/Home behavior, broad map/Asset formats, arbitrary game-server operations, distributed persistence, and production deployment hardening are outside this demo. Consult `spec-mapping.md` for per-section implementation and acceptance references.
