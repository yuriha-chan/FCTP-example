# Implementation plan

## Status and authority

`protocol.txt` remains the protocol authority; `plan.txt` defines MVP scope and acceptance. The source inputs are unchanged. Adopted local implementation decisions are definitive in `implementation-conventions.md`; historical open statuses in earlier handoffs/registers are superseded by those decisions. Current implementation and test evidence is traced in `spec-mapping.md`.

## Stages and acceptance

| Stage | Delivered scope | Acceptance reference | Current record |
|---|---|---|---|
| 0. Specification groundwork | Traceability, conventions and limitations | `docs/spec-mapping.md`, `docs/implementation-conventions.md`, `docs/limitations.md` | Complete |
| 1. Workspace and shared protocol/identity foundation | Pinned npm workspaces, runtime validation, extension retention, Actor resolution, token derivation and real Data Integrity proofs | `tests/foundation.test.ts`, `tests/verification.test.ts`, `tests/message-fixtures.test.ts`; `docs/handoffs/foundation.md`, `docs/handoffs/message-fixtures.md` | Implemented; see individual command records |
| 2. Resources and Client SDK/browser | Fetch resources, Collections, cache isolation, map selection, SDK and browser client | `tests/foundation.test.ts`, `tests/client-data.test.ts`; `docs/handoffs/client.md` | Implemented; UI testing remains pending |
| 3. Federation, host and test authority | Multi-Actor hosting, durable delivery, retries/dedup, Home/Registry workflows | `tests/host.test.ts`, `tests/server-wire.test.ts`, `tests/home.test.ts`, `tests/registry.test.ts`, `tests/authority-app.test.ts` | Implemented; evidence in their handoffs |
| 4. Territory A | Persisted policy, immediate mining/manufacture, inventory, cargo and signed exits | `tests/policy-domain.test.ts`, `tests/policy-territory.test.ts`, `tests/policy-app.test.ts` | Implemented |
| 5. Territory B | Distinct facility/tick, reservation, capacity, production and handling model | `tests/sim-domain.test.ts`, `tests/sim-territory.test.ts`, `tests/sim-app.test.ts` | Implemented |
| 6. Cross-Territory circulation | A produced cargo to B, imported reprocessing, return exit and B-native production | `tests/circulation.test.ts`; `docs/handoffs/circulation.md` | Focused actual-HTTP acceptance passed |
| 7. Launcher and integration | Local composition, browser static delivery and bundled client | `tests/demo-launcher.test.ts`; `docs/handoffs/launcher.md` | Implemented; launcher handoff's earlier failure is superseded by subsequent integrated checkpoints where noted |
| 8. Broad acceptance and UI | Full configured gate and user-facing browser checks | `npm test`; manual UI walkthrough; `docs/handoffs/final-verification.md` | Configured broad gate passed: build, browser bundle, test typecheck, ESLint and 61 runtime tests. UI walkthrough remains unverified. |

`npm test` is configured as build → test typecheck → ESLint → all runtime tests. The fresh broad-gate run recorded in `docs/handoffs/final-verification.md` passed all stages and all 61 runtime tests. Historical focused command outcomes remain scoped to their handoff; the circulation handoff establishes that acceptance specifically. No UI walkthrough is claimed.

## Cross-cutting constraints

- Browser-safe packages remain free of Node APIs; the Client SDK does not depend on server-base.
- Shared baseware provides communication and factual validation, not trust policy, production authority, or automatic cargo reconciliation.
- Preserve unknown extension fields and do not add mandatory FCTP fields.
- Territory A and B retain distinct internal economic and administrative models.
- Durable retries preserve IDs and signed payloads; delivery success is distinct from business success.
- Native tokens are not logged or sent to resource servers; equal-revision conflicts follow the adopted fail-closed convention.
- Local APIs, production recipes and map representation remain labeled as local conventions where appropriate.
