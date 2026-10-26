# Limitations and implementation status

## Implemented scope

The repository contains shared protocol, identity, resource, authentication, federation, server, and SDK packages; a test Home/Registry authority; distinct policy and simulation Territory applications; a browser client; and a loopback launcher. Focused acceptance and unit outcomes are cited in `spec-mapping.md` and individual handoffs. A fresh `timeout 180s npm test` passed build, browser bundle, test-source typechecking, ESLint and all 61 runtime tests; evidence is in `docs/handoffs/final-verification.md`. No UI testing is claimed.

## Known limitations

- Persistence is `JsonSnapshotStore`: a single-process local JSON snapshot with serialized mutations and atomic temporary-file rename. It is not a multi-process database or distributed coordination layer.
- Demo services bind to `127.0.0.1` and use HTTP. This is a local-development exception; production FCTP resource URLs require HTTPS.
- Published maps are small ASCII/text resources and Assets are text-only. The client supports the documented local ASCII format and reports unsupported formats rather than rendering arbitrary media.
- The test authority is minimal: one configured Player, demo vessel, Home and Registry state, not a production identity or registry service.
- Territory operation routes under `/local/` are experimental application APIs, not standardized FCTP endpoints. Their payloads and A/B behavior are deliberately different.
- The browser retains native and administrator credentials only in page memory. Refreshing discards them; a new page session must issue or enter credentials again. A rotated native token also requires re-deriving/reissuing the relevant access state and delivering updated digests.
- No automated or manual UI testing is recorded as complete. Browser behavior should be exercised by the user.
- Worker delivery is integrated in the launcher, while lower-level `processInbox`/`processOutbox` remain caller-driven APIs.
- The JSON-LD context URI is provisional and resolved using a fixed local document loader. The adopted Activity envelope and ASCII map format are implementation conventions, not new FCTP requirements.

## Protocol features outside the MVP

The implementation targets the MVP path and does not claim every optional or complete profile feature in `protocol.txt` §§12.1–12.6. Full asset lifecycle/subscription and permission workflows, generalized route lifecycle/route requests, production-grade Registry/Home behavior, broad map/Asset formats, arbitrary game-server operations, distributed persistence, and production deployment hardening are outside this demo. Consult `spec-mapping.md` for per-section implementation and acceptance references.
