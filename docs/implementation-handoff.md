# FCTP implementation handoff

## Launcher, client and circulation checkpoint

- `apps/demo/src/launcher.ts` composes existing app factories. `docs/handoffs/launcher.md` records lifecycle, default ports and build contract.
- `tests/circulation.test.ts` passed five real-HTTP scenarios, including complete produced-cargo circulation, independently signed exits, B-native production, non-adoption and mismatch facts. API evidence and sanitization notes: `docs/handoffs/circulation.md`, `docs/memos/circulation.json`.
- Browser Client exists, with shared-resource rendering, explicit local A/B controls and independent signed evidence/request-binding helpers. Focused client-data and message-fixture checks passed. A and B publish map format `https://fctp.example/formats/ascii`; do not alias the accidental `/map/ascii` identifier.
- Assignment references such as `plan4` mean the named section of `/app/plan.txt`, not another file.

## Inputs and authority

- Source specifications: `/app/protocol.txt` and `/app/plan.txt`. Read the sections relevant to the assigned unit, plus any explicitly assigned references.
- `protocol.txt` is the primary protocol authority. `plan.txt` defines MVP scope and acceptance.
- Follow `/home/ai/.config/opencode/AGENTS.md` and applicable repository instructions.
- Stop and ask the supervising agent on contradictions or unclear requirements. Do not invent protocol semantics.

## Repository findings

- Repository root: `/app`; Git repository, initially no tracked application code.
- Initial files: `protocol.txt`, `plan.txt`, `opencode.json`, `tui.json`, and `.git/`.
- All four initial files were untracked. Preserve them as user work.
- No repository-local `AGENTS.md` was found.
- The interrupted foundation task selected npm workspaces, TypeScript project builds, ESLint, tsx/Node tests, Node HTTP, and a JSON snapshot store. Pinned dependencies are in `package-lock.json`.
- Shared packages, authority workflows, both distinct Territory apps, browser Client, and launcher exist. Integrated launcher/browser bundle and complete suite verification are the current final gate.
- Context7 is unavailable. The user explicitly selected “Waive Context7 requirement” and authorized implementation using available tools and official documentation without Context7.

## Implementation plan

1. Establish specification mapping, explicit MVP conventions, acceptance traceability, and reproducible TypeScript workspace tooling.
2. Implement browser-compatible protocol types, runtime validation, cargo comparisons, token cryptography, actor resolution, and actual `eddsa-rdfc-2022` proofs. Keep cryptographic verification, key attribution, and expected issuer checks separate.
3. Implement shared Fetch resource retrieval, authenticated collections, cache isolation, map format selection, SDK, and a limited text/ASCII browser client.
4. Implement multi-Actor server hosting, persistent stores, Inbox/Outbox, duplicate detection, durable retries, and minimal Registry/Home authorities.
5. Implement policy Territory A: persisted administrator rules, mining, material-consuming manufacture, independent inventories/cargo, entry/berthing/loading/departure, and signed exits.
6. Implement simulation Territory B independently: discrete ticks, facilities, finite capacity, reserved inputs, timed production/handling, and the same federation messages.
7. Complete the A production → load → signed exit → B entry → unload → reprocess → reload → signed exit scenario, plus B-native mining/manufacture.
8. Verify schemas and fixtures, distinct domain models, evidence binding, non-adoption of Registry notifications, token revisions/revocation, proxy parity, retry/deduplication, persistence, administrator authorization, type checking, and ESLint. Ask the user to perform UI testing.

## Non-negotiable boundaries

- Browser-safe `protocol`, `identity`, `resources`, and `auth`; no Node imports there.
- Client SDK must not depend on server-base; shared packages must not import Territory domain models.
- Shared baseware supplies communication and factual validation, never trust policy, production authority, or automatic cargo reconciliation.
- Territory A and B must have distinct internal economic and administrative models, not only different policy values.
- Real production must create cargo and consume materials; static manifests and mock-only implementations do not satisfy acceptance.
- Preserve unknown extension fields and avoid extra mandatory FCTP fields.
- Publish local API and JSON-LD/map/wrapping choices as MVP conventions, not FCTP requirements.
- No custom cryptography standing in for `eddsa-rdfc-2022`.
- Durable delivery retains IDs and signed payloads. Delivery success is separate from business success.
- Keep native tokens out of resource servers and logs; equal-revision conflicts fail closed under a documented convention.

## Instruction locations

- Subagent requirements: `docs/subagent-instructions.md`.
- Supervisor requirements and orchestration queue: `docs/supervisor-instructions.md`.
- This file records shared implementation context and findings.

## Current status

- Shared foundation code exists under `packages/{protocol,identity,resources,auth,federation,server-base,client-sdk}`. Historical focused checkpoints remain scoped to their recorded tests; the current broad-gate evidence is recorded below.
- Workspace conventions and traceability are in `docs/implementation-conventions.md`, `docs/implementation-plan.md`, `docs/spec-mapping.md`, and `docs/limitations.md`.
- Supervisor decisions recorded in `docs/implementation-conventions.md` are adopted and supersede historical register statuses; no further confirmation is required for those choices.
- Environment verified: Node v24.22.1; npm 11.19.1.
- `docs/handoffs/foundation.md` contains the exported API summary, security defaults, explicit worker lifecycle, check results, and coverage limits. Supervisor reviewed this document and `server-base/src/server.ts`; generic handlers receive verification reports and must explicitly enforce application requirements.
- `createInboundVerifier` is exported from server-base; see `docs/handoffs/verification.md`. Supervisor ran typecheck → lint → tests sequentially; all passed (10 tests). Package runtime exports use compiled `dist/`, so tests must follow the build, not run concurrently with it.
- Generic persistent hosting is `createHost` in server-base; `createAuthority` delegates to it. See `docs/handoffs/host.md`. Its initial integration check exposed previously unchecked test type errors; a bounded verification repair is pending.
- A's immediate rule-based ledger and B's mutable tick/facility ledger exist in each app's `src/domain.ts`; see their domain handoffs. Supervisor found and delegated cargo identity/mass/global reservation repairs. A explicitly rejects anonymous conversion of rich cargo; B retains structured quantity buckets. B's focused repair checks passed. They remain distinct economic implementations.
- Supervisor mechanical checks are delegated by user requirement. Supervisor reviews specification interpretation, domain boundaries, duplicated abstractions, and patch-work integration.

## Integrated server checkpoint

- Historical integrated checkpoint: `timeout 180s npm test` passed 42 runtime tests after fixture repairs. The current broad-gate result below supersedes its test totals and any later stale blocker record, not API contracts.
- Both complete ExitEvent and enclosing Activity independently verify after JSON roundtrip. Keep full nested context/proof; never strip it as a workaround.
- `createHost` owns keys, object signing and lifecycle; adapters own local economic decisions.
- Home revision transitions serialize per Player. Registry consumes operation deltas with exact request binding and explicit adoption.
- Fake HTTP fetchers must strip key URI fragments just like actual HTTP. Clean up servers even when assertions fail.
- Next app-layer contract: `docs/handoffs/application-contract.md`.

## Final integration findings

- Fresh bounded gate: exactly one `timeout 180s npm test` run exited 0. Build (TypeScript project builds, browser client compilation and browser esbuild bundle), test-source typechecking, ESLint and all 61 runtime tests passed; 0 failed, 0 cancelled, 0 skipped, 0 todo. See `docs/handoffs/final-verification.md` and `docs/memos/final-verification.json` for exact scope.
- The integrated host worker retry test, inbox recovery, message fixtures, actual-HTTP circulation and outage-recovery tests, and launcher HTTP/static/shutdown tests passed. The old immediate retry expectation and leaked-listener failure are superseded by this measured integrated result.
- Reusable outage API finding remains: `FctpServer.resolveRecipientInbox(actorId)` validates and persists the remote Actor plus absolute inbox URI in `remoteActors`; cached known-recipient routing permits local commit during outage, while an unknown recipient requires online resolution. Simulation retains the `registryInbox` override. Details are in `docs/handoffs/delivery-outage.md`.
- The test helper's URL issue is resolved: the launcher test resolves relative routes with `new URL(path, base)` and fetches absolute Actor/map identifiers directly. HTTP responses for actual client assets and shutdown passed in the integrated run; no browser/DOM behavior was tested. This gate does not establish full protocol/profile compliance.
