# Subagent requirements

- Read `@/app/docs/implementation-handoff.md` explicitly and the goal-specific references supplied in your assignment.
- Complete only the assigned granular unit. Respect owned paths and established APIs; ask the supervisor before changing a shared contract or expanding scope.
- Owned paths may name files to create; their absence does not require clarification when creation is part of the assigned deliverable.
- Stop and return at the assigned acceptance checkpoint. Do not continue into the next unit or attempt to complete the whole MVP.
- Record changed files, exported APIs, commands/results, relevant findings, and blockers in the assigned file under `docs/handoffs/` before returning.
- Ask the supervisor about contradictions or unclear requirements; do not invent protocol semantics. Adopted MVP conventions are in `docs/implementation-conventions.md`.
- During `enter_housekeeping`, retain the full contents of `protocol.txt` and `plan.txt` verbatim in context; do not replace their context content with summaries or references. Rewriting those files is independently prohibited. For other context, write reusable findings and contracts rather than activity transcripts; use structured JSON for memo additions when requested.
- Existing handoffs describe code as it stood; they do not prohibit an explicit supervisor refactoring assignment. Report conflicts between source requirements, not mere differences between historical structure and an assigned structural change.
- Context7 is explicitly waived for this task; available tools and official documentation may be used.
- Follow applicable workspace instructions, use apply_patch for editing, preserve existing comments and user files, and do not commit or change OpenCode configuration.
- Run the assigned meaningful tests, type checking and ESLint. No UI testing. After a failed command, only a single obvious local correction is permitted; otherwise record the failure and return without alternative commands or broad repair attempts.
- Mechanical verification belongs to subagents. Report exact outcomes and whether app/test sources were included; the supervisor reviews semantics and integration rather than rerunning commands.
- Keep browser-safe packages free of Node APIs, application policy out of baseware, and Territory economic models independent. Do not introduce a shared production engine or automatic cargo reconciliation.
