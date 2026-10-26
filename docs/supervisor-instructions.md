# Supervisor requirements

## Responsibility and continuity

- Supervise implementation through the full MVP acceptance criteria in `plan.txt`; a subagent checkpoint is not a supervisor stopping point.
- After every bounded result, review changed code and verification, update shared findings, then delegate the next ready unit. Continue until the goal is complete or an actual blocker requires the user.
- Make and document local implementation choices authorized by the plan. Ask the user on actual specification contradictions or genuinely unresolved requirements.
- Context7 has been explicitly waived by the user for this task.
- During `enter_housekeeping` context compression, retain the complete contents of `protocol.txt` and `plan.txt` verbatim in context. Do not compress them or replace them with summaries or references. This is a context-retention requirement, distinct from the existing prohibition on rewriting the source files. Other context summaries must be reusable knowledge, not chronological transcripts. Maintain structured memos under `docs/memos/`, preferably JSON with decisions, reasons, evidence paths, status, and actionable follow-ups.
- Use housekeeping after a related chunk completes, proactively for focus and economical context use rather than waiting for pressure. Compress only finished work ranges; retain the recent ongoing range and important early conversation untouched. If `enter_housekeeping` is unavailable in the tool inventory, report that limitation rather than claiming to invoke it.

## Delegation

- Use fresh General subagents with narrow goals instead of repeatedly resuming a growing context.
- Give each subagent `@/app/docs/subagent-instructions.md`, `@/app/docs/implementation-handoff.md`, relevant goal-specific handoffs, explicit file ownership, acceptance checks, and a return point.
- Keep supervisor requirements in this file; do not put them in subagent instructions or shared factual findings.
- Keep code structure, APIs, evidence, and status in `implementation-handoff.md` and `docs/handoffs/`. Do not require every agent to reread the entire MVP when its bounded goal needs only selected sections.
- Parallelize only units with independent owned files and established contracts. Supervisor owns shared orchestration/configuration changes unless explicitly delegated.
- Review each checkpoint before accepting it. Do not equate passing focused tests with full protocol compliance.
- Supervisor review is semantic: inspect specification interpretations, domain ownership, parallel or competing abstractions, patch-work integration, and whether scenarios demonstrate the intended goals. Delegate mechanical type, lint, test, and build checks to subagents; do not run them in the supervisor session.
- On failures, investigate the reported cause and delegate a bounded repair if permitted by workspace rules. No repeated broad repair loops or alternative-command workarounds.

## Work queue

1. Inbound verification adapter.
2. Persistent test-authority Actor/key bootstrap and discovery.
3. Home token issuance, digest/revoke delivery, and proxy retrieval.
4. Registry requests/events and explicit cargo-adoption switch.
5. A mining/manufacturing ledger and administrator rules.
6. A federation transitions and signed exit evidence.
7. B facility/tick/reservation ledger.
8. B timed federation transitions and signed exit evidence.
9. Cross-Territory economic scenario and negative cases.
10. Browser resource browsing, then local operation panels.
11. Execution documentation, fixtures, and acceptance traceability.

Split items further as needed. Assign appropriate automated checks, including type checking and ESLint, to subagents; ask the user to perform UI testing. Preserve original files and do not commit without request.
