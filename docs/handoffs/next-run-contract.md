# Next-run implementation contract

## Purpose

Close the approved pre-run and interface work before the next role-playing session. This is not a redesign of FCTP. Authored Varieties remain canonical FCTP objects; only local Territory policy is added.

## Supervisor decisions

### Non-owner Asset text

Public Asset media must be readable by someone who is not the author or session owner. In the browser client, a text media button must first attempt the public resource GET without credentials. Only a 401 or 403 may fall back to the Actor-scoped diplomatic-token read. 404 and other failures remain visible errors. Failures must not be hidden behind the private authoring catalog.

The Authority already publishes `/objects/players/<name>/media/<id>` as public `text/plain`. Do not change that into a secret route. Preserve `textContent` rendering and the existing browser harness.

### Policy A audit attribution

Player-initiated A operations must record the authenticated Player Actor URI, not `system`, in the local audit. The missing actor is threaded through the domain operation, Territory adapter, and authenticated app route. Internal or preview operations may retain `system` as the default.

- `mineOre`, `manufacture`, `transferWarehouseToPort`, `transferPortToWarehouse`, `loadCargo`, `unloadCargo`: optional actor, default `system`.
- `prepareVessel` and `exitVessel`: actor supplied by the Territory from the Registry request context; do not fabricate a Player.
- App `mine`/`manufacture`/`transfer`/`load`/`unload`: pass the authenticated Player URI.
- Cargo operations still require the active-visit possessor check in the app. Attribution does not weaken authorization.
- Action-discovery previews must remain read-only and need not persist audit.

### Minimal governmental Variety choice

A gains one small local policy choice: a porting permit keyed by the exact canonical FCTP Variety URI.

```ts
interface Policy {
  // existing fields...
  varietyPortPolicy?: Record<string, 'allow' | 'deny'>;
}
```

- Keys are absolute canonical Variety IDs, not locally invented IDs and not shadow Variety objects.
- Missing entry means `allow`; `deny` rejects `load` and `unload` of that exact variety.
- Rejection leaves port inventory and vessel manifest unchanged and is audited with the acting Player.
- Policy validation accepts only safe absolute URI keys with the value `allow` or `deny`.
- Do not rewrite, clone, or register a different Variety object. Do not claim the FCTP object itself changed.
- Document this as a local A permit policy. B does not need the same mechanism in this unit; its absence is a real implementation difference, not a protocol failure.

### Observer reporting

Observer guidance must prefer concise factual/statistical in-game board reports:
- observed quantities, timestamps or tick numbers, named events, signatures/evidence only when inspected,
- clearly separated participant claims and unverified material,
- no mechanical gazette, arbitrary world events, narrative omniscience, or grading of social health.

The observer may report numbers and actual events; it must not invent them or turn the board into a server log.

### Pre-game surface and prompts

Prepare a new run package, not a continuation of the completed roleplay world:
- a public Arrivals forum for introductions and optional technical questions, non-binding plans,
- a pinned Developer desk clearly marked out-of-character, for factual updates, known issues and future directions, not a help desk or story director,
- the world visible but frozen before tick 0,
- an advertisement with short paragraphs aimed at makers, traders, record-keepers/critics, writers/teachers, system tinkerers, social observers, and curious/late joiners; it must honestly state what authoring does and does not do,
- participant guidance that treats reflection as private and personality-selective: who the character wants to affect, which consequences matter or are dismissed, what felt meaningful, what remains open, and whether to return, hand off, or abandon,
- a return-time default: check one open loop before starting something new,
- no forced enthusiasm, required friendship, social quota, or economic success target.

Use examples of reasons to talk that the agent may choose; do not prescribe topics, hobbies, jokes, or institutions. Recurring social institutions should be discoverable objectives, not authored requirements.

## Owned units

1. Client readability: `apps/client/src/main.ts`, focused client/browser test, handoff.
2. Policy attribution and Variety port permit: A domain/territory/app/actions, policy tests, handoff.
3. Pre-game docs and prompts: new run directory under `run/`, run handoff.
4. Observer/participant guidance and advertisement: same run directory.

The supervisor directly reviews prompt flavor and user-facing text before any run.

## Verification boundary

Mechanical checks are delegated. The integrated gate must include build (including browser bundle), test-source typecheck, ESLint, and the full runtime tests. No browser UI acceptance is claimed without user testing. No commit unless requested.

## Status

Units 1 and 2 are implemented with focused tests; the pre-game package covering units 3 and 4 exists under `run/harbor/`. The integrated `timeout 180s npm test` gate exited 0 with build including `dist/client/main.js` (490696 bytes), test-source typecheck, ESLint, and 85/85 runtime tests; `git diff --check` was clean. No world was launched, `run/` is excluded from Git, no browser manual UI acceptance is claimed, and no commit was created. Evidence: `docs/handoffs/asset-readability.md`, `docs/handoffs/policy-audit-variety.md`, and `docs/handoffs/next-run-verification.md`.
