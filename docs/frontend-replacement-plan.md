# Frontend replacement plan

## 1. Objective and boundaries

Build an intuitive frontend using:

- **Vite + TypeScript + React**
- **binduct** for shared frontend state
- **React Aria Components** as the base; **React Aria Hooks** where complex interactions require them
- **CSS Modules + CSS custom properties** for component styling and design tokens

**Goal: functional equivalence, not one-to-one correspondence or backward compatibility with the current frontend.**

Retain the stateful Client application backend, persistence, authentication, and world-operation contracts. Minimal API changes are permitted when they materially improve contextual picking. Do not introduce another backend state owner, direct-world browser adapters, or browser-held native credentials.

The capability baseline is the authoritative frontend requirements and operation contracts—not the existing screen layout. Existing implementation defects are not behavior to preserve.

## 2. Information architecture

Use topic tabs, with only the selected topic displayed:

| Topic | Purpose |
|---|---|
| **Explore** | Discover places, inspect connectivity and capabilities, select destinations and routes |
| **Logistics & Production** | Select vessels, manage visits and cargo, perform operations, follow jobs and journeys |
| **Author & Publish** | Separate Asset and Variety authoring workflows, with Library access |
| **Activity** | Follow submissions, pending results, evidence, and failures |
| **Administration** | Separate, explicitly authority-scoped governance workflows |

An account switcher remains available in the application shell. Connections/discovery settings are accessible without becoming another permanently stacked section.

Tab changes preserve working drafts and appropriate selections. Account changes isolate private state and invalidate account-specific pending renders.

## 3. Scenario-based capability list

Each scenario becomes a coverage item with a user-visible outcome, backend evidence where applicable, and verification.

### A. Sign in and manage accounts

1. **First visit:** I see a clear sign-in screen and can sign in using my account handle and password.
2. **Add another account:** I can add a second account without signing out the first.
3. **Switch accounts:** I can identify and select an account, including same-name accounts on different servers.
4. **Return later:** My saved client session survives browser restart.
5. **Selective logout:** Signing out removes this browser’s selected session without revoking another caller’s session.
6. **Rejected session:** I receive an actionable sign-in prompt rather than another account’s data or a silently anonymous private view.

Login destinations remain handle-derived; no Home-origin override returns.

### B. Discover and understand the world

7. **Discover a server:** I enter a server origin or supported handle and see the published identities and capabilities.
8. **Inspect a place:** I can distinguish its ports, areas, connections, available operations, and known prerequisites.
9. **Choose a destination:** I can find a Port using contextual suggestions or text search, inspect it, and select it.
10. **Understand travel constraints:** I can distinguish unknown connectivity, known absence of a directed route, and permission restrictions.
11. **Prepare travel:** My chosen vessel, destination, and directed route carry into Logistics without re-entering identifiers.

### C. Move and operate a vessel

12. **Inspect my vessel:** I see cargo, recorded location, visit state, adoption, and pending requests, with sources and freshness.
13. **Enter a Territory:** I select an appropriate Port and submit entry, then distinguish submission, manual review, approval, and actual berthing.
14. **Traverse a route:** I execute the selected directed journey and follow each leg’s real completion.
15. **Handle uncertain movement:** A failed readback remains uncertain; refreshing does not silently resubmit movement.
16. **Depart:** I can follow departure and signed exit evidence without treating an acknowledgment as completion.

### D. Produce and move goods

17. **Choose an operation:** I see available operations, inputs, blockers, quantities, and output destinations for the selected vessel and Territory.
18. **Perform work:** I mine or manufacture with selected inputs and observe actual results.
19. **Move cargo:** I load, unload, or transfer goods while distinguishing my cargo from shared Territory stocks.
20. **Follow timed work:** I inspect a pending job, return after restart, and explicitly refresh its status without advancing simulation time.
21. **Choose a resource:** Variety, tool, or Area selection happens directly from the relevant operation field.

### E. Author, publish, read, and reference

22. **Author an Asset:** I create, save, reopen, edit, and publish an Asset in a dedicated Asset editor.
23. **Author a Variety:** I use a separate Variety editor with structured descriptive Production fields.
24. **Insert a reference:** From the exact field being edited, I open an Asset, Variety, or Area picker and insert the selected reference directly.
25. **Inspect before selecting:** I can read a candidate without losing my draft or selection context.
26. **Understand publication:** I distinguish accepted publication from successful public readback and can inspect retained references after readback failure.
27. **Preserve authored content:** Reopening and saving a draft does not silently discard supported extensions or unrelated fields.

Descriptive Production does not become an executable recipe.

### F. Follow outcomes and administer

28. **Review activity:** I find my submissions and understand pending, completed, rejected, stale, unavailable, and unverified states.
29. **Recover context:** An Activity item leads back to the relevant resource, job, vessel, or journey.
30. **Select administrative authority:** I explicitly choose the authority being managed and see only controls supported by established authorization.
31. **Review entry:** I approve or reject a retained request and distinguish the decision from eventual berthing.
32. **Change controls:** I inspect observed settings, submit a change, and verify the resulting state.
33. **Manage Home availability:** An authorized governor can manage accounts under the established self-disable restriction.

This frontend work does not resolve or normalize delegation of remote server-root secrets to a public Client.

## 4. Contextual picker design

Provide dedicated **Asset, Variety, Port, and Area pickers**, sharing interaction primitives but retaining type-specific information.

### Entry points

A picker opens from its destination field or operation:

- Asset reference → Asset picker
- Ingredient Variety → Variety picker
- Entry destination → Port picker
- Production Area → Area picker

There is no global “where should this reference go?” router.

### Candidate presentation

Use context-sensitive groups such as:

- **Recently mentioned** — resources referenced in the current workflow or available retained context, with their context identified
- **Related to this draft or operation**
- **Nearby ports for Vessel #1**
- **Search results**, updated as the user types

“Nearby” must be grounded in known position and published directed geography—not server proximity or invented reverse links. Candidates must distinguish connectivity from admission permission and explain insufficient position/connectivity data.

Each candidate shows a useful name, type-specific summary, source/freshness, and inspection action. Exact identifiers remain available in details.

Type-ahead requests need bounded loading, empty, stale, and failure states; obsolete responses must not replace newer results. Whether search is local over retained candidates or requires explicit remote observation must remain clear.

### Minimal API changes

First assess what existing page responses already support. Add or refine APIs only for concrete gaps—for example, obtaining typed contextual candidates with provenance without downloading unrelated state.

For each proposed change, record:

1. The user interaction it enables.
2. Why the existing contract is insufficient.
3. The smallest request/response change.
4. Its authentication, freshness, and retained-read implications.

Do not introduce a speculative general-purpose search framework.

## 5. Implementation phases

### Phase 1 — Coverage and interaction design

- Map the scenarios above to the authoritative requirements and existing application endpoints.
- Produce screen/flow sketches for login, tabs, account switching, contextual reading, and each picker.
- Identify concrete API gaps and unresolved behavior before substantial coding.

### Phase 2 — Stack and binduct integration

- Establish the Vite build and React shell.
- Verify binduct subscription, cleanup, replacement, array, and React lifecycle behavior with small tests.
- Define shared state responsibilities without duplicating backend-owned domain state.
- Establish design tokens and accessible component primitives.

### Phase 3 — Accounts and navigation

- Implement sign-in, persistent sessions, account switching, selective logout, tabs, and account-isolated request handling.

### Phase 4 — Readers, pickers, and authoring

- Implement contextual resource inspection and typed pickers.
- Build separate Asset and Variety editors.
- Verify draft persistence, reference insertion, publication, and readback.

### Phase 5 — Explore, logistics, and production

- Implement vessel-relative discovery, route handoff, movement, cargo operations, production, and job tracking.

### Phase 6 — Activity and administration

- Implement outcome/evidence presentation and authority-scoped administrative workflows.

### Phase 7 — Replacement and acceptance

- Remove superseded frontend code and obsolete interface-specific tests.
- Update build, static serving, and Docker integration for Vite output.
- Run complete scenario coverage and browser usability review.

Feature work follows TDD; removal does not require manufactured tests asserting that deleted UI is absent.

## 6. Experimental-library issue reports

Stop affected work and report binduct problems using:

```text
Issue:
Dependency version/commit:
Minimal reproduction code:

Expected behavior:
—or—
Alternative behavior requiring a decision:

Actual behavior:

Affected frontend capability:
```

Do not silently replace binduct, patch its internals, or build a parallel mechanism to bypass an unresolved issue.

## 7. Acceptance criteria

Completion requires:

- Scenario coverage, including actual world effects where relevant.
- Keyboard and focus behavior for tabs, dialogs, pickers, and forms.
- Account isolation and protection against late responses.
- Honest freshness, uncertainty, and completion evidence.
- Draft preservation across navigation.
- Successful application build, regression tests, and deployment integration checks.
- Removal of the superseded frontend.

**Automated functional verification and your usability acceptance remain separate gates.** No Harbor launch or historical-state modification is part of this plan.
