# Frontend requirements and priorities

## Objective

Make the frontend a place to understand the world and act within it, rather than a thin wrapper around raw APIs. Organize around user activities, readable resources, and places. Increasing the number of servers must expand the discoverable world without multiplying top-level navigation items or requiring users to inspect every server individually.

## Priorities

Assign priority to individual requirements, not application sections.

| Priority | Meaning |
| --- | --- |
| P0 | Required to run the game through the client: discover places, travel, manage goods, produce, publish and read works, and carry out administrator decisions. |
| P1 | Makes those activities easier to discover, coordinate, and repeat as the world grows. |
| P2 | Additional convenience for established workflows. |

The first delivery must complete the P0 workflows across sections. Completing one whole section while another essential game action remains unavailable does not meet that goal.

## Agreed information architecture

| Area | Purpose |
| --- | --- |
| Overview | Understand the current situation, unresolved matters, and recent outcomes. |
| Explore | Discover places geographically and by capability; understand routes and choose where to engage. |
| Logistics & Production | Manage vessels, cargo, visits, movement, stocks, repeated production operations, and jobs. |
| Author & Publish | Compose and publish creative definitions, with Library as a subsection. |
| Activity | Follow requests, decisions, operations, failures, and verified outcomes. |

## Overview

- **P1:** Summarize cargo, recorded position, pending requests, active work, relevant local conditions, and recent outcomes in one place.
- **P1:** Prioritize changes and unresolved matters in the summary.

The underlying information and actions remain P0 in their operational workspaces; the combined overview is P1.

## Explore

Place discovery is the primary Explore experience. Geography-based and capability-based discovery lead into route selection and traversal.

### Geography-based discovery

- **P0:** Show places and their geographical connections.
- **P0:** Let users identify their vessel's recorded position, including uncertainty or conflicting observations.
- **P0:** Let users follow connections outward, open connected places, and inspect onward connections.
- **P1:** Preserve the geographical browsing path when navigating between places.
- **P0:** Let users choose a connected destination and inspect the route legs, traversal requirements, and known obstacles.
- **P0:** Let users traverse the route with a vessel and inspect movement outcomes.
- **P0:** Carry the selected destination and route from Explore into journey execution and monitoring in Logistics & Production.

### Capability-based discovery

- **P0:** Show a place's supported activities, required inputs, outputs, and known prerequisites on its detail page.
- **P1:** Search across places by supported activity, required input, or desired output.
- **P1:** Explain why each capability search result matches.
- **P1:** Present route information from the selected origin alongside capability search results.
- **P0:** Allow a user inspecting a place's capability to locate that place geographically and continue into a journey or operation.

### Connected views

- **P0:** Geography and capability views use the same place identities.
- **P1:** Preserve origin, destination, selected place, and relevant filters when switching views.
- **P1:** Find relevant capabilities along a route and routes to a capability search result.
- **P0:** Distinguish unknown connectivity from known unreachability, and a geographical connection from permission to traverse it.

### Geographical connections and traversal

- **P0:** Support place identities, geographical relationships, direction where applicable, traversal requirements, vessel position, movement operations, and journey outcomes throughout the route workflow.

Explicit routes from port to port and boundaries establish geographical connections.

### Acceptance direction

A user can discover a destination geographically or by capability, inspect the route and known prerequisites, begin traversal, and follow its outcome without reconstructing the selection in another workspace. Unknown or unsupported steps are identified precisely.

### People and Works

- **P0:** Open a place's authority and linked publications, and follow a work's author and resource references.
- **P1:** Browse People and Works across connected sources, including an author's related work.
- **P1:** Preserve search and browsing context when following those links.

Explore's Works discovery searches outward; Library supports resource use within authoring. Both use the same resource reader.

## Logistics & Production

Support the connected operational journey: find inputs, obtain and move them, produce, inspect outputs, and move outputs onward.

- **P0:** Inspect vessels, cargo, local visits, shared stocks, operations, and jobs in Logistics & Production.
- **P0:** Submit entry and departure requests and inspect their decisions and resulting visit state.
- **P0:** Load and unload goods through supported operations and inspect the resulting cargo and stocks.
- **P0:** Keep vessel cargo distinct from shared Territory stocks.
- **P0:** Show inputs, quantities, permissions, capacity, known blockers, and output destination for an operation.
- **P0:** Execute supported production operations and inspect their results.
- **P0:** Separate executable operations from authored production descriptions.
- **P0:** Show active jobs, their operation and quantity, and remaining time when available.
- **P0:** Allow repeated production using an existing Variety without republication or another authoring workflow.
- **P0:** Recheck prerequisites against current observations when submitting an operation.
- **P2:** Offer a repeat shortcut that retains the previous operation's selections for review.

### Action lifecycle

- **P0:** Before an action, explain what is submitted, where it goes, prerequisites, and the expected kind of result.
- **P0:** During an action, distinguish sending, acknowledgment, pending external decision, work in progress, and an unverified outcome.
- **P0:** After an action, show success or failure, the resulting resource/request/job, and verified changes.
- **P1:** Offer contextual next actions after a result.
- **P0:** Distinguish entry requested from entry accepted, and request acknowledgment from completed movement or production.
- **P0:** If submission succeeds but read-back fails, report both facts separately.

## Author & Publish

### Library

- **P0:** List the user's published resources and open known resources for reading and selection during authoring.
- **P1:** Search and filter Library resources for composition and publication.
- **P0:** Make the resource reader accessible from operational and discovery workflows.
- **P1:** Preserve the originating workflow's context when opening and closing the reader.

### Authoring and publication

Variety publication is a one-time creative activity. Repeated production using an existing Variety belongs in Logistics & Production.

- **P0:** Provide human-readable fields and submission for Asset and Variety publication, including production descriptions with repeatable ingredients, yields, and resource references.
- **P1:** Preview the complete resource before publication.
- **P2:** Keep advanced JSON available as an optional editing surface.
- **P0:** Make a successful publication lead directly to its readable resource and identity.
- **P0:** Present actual Asset text or media, author and source when known, and relevant references.
- **P0:** Retrieve public resources without credentials first; use authentication only when required and supported by a known Actor audience.
- **P0:** Show precise retrieval failures and missing prerequisites.
- **P0:** Allow authored descriptions to be read and selected as references or ingredients even without an executable operation.
- **P1:** Link definitions to known production opportunities, keeping publication and execution distinct.

## Activity

- **P0:** Let users retrieve pending requests and their decisions and inspect the current result of submitted actions.
- **P1:** Provide a consolidated interaction history with attempt, destination, time, acknowledgment, verified outcome, and unresolved state.
- **P1:** Link later observations to the relevant interaction where reliable.
- **P2:** Make exact technical request/response details expandable from the interaction history.

## Administrator workflows

- **P0:** Let administrators inspect pending requests and the policy and operational information needed to decide them.
- **P0:** Let administrators submit supported approval and rejection decisions and inspect the outcomes.
- **P0:** Let administrators inspect and change supported policies and operational controls.
- **P0:** Show the target and submitted values before applying an administrative change, and its result afterward.
- **P1:** Provide a consolidated administrator decision and change history.

## Requirements for all screens

### Freshness, provenance, and scope

- **P0:** Show source and observation age for independently retrieved sections.
- **P0:** Distinguish empty, not retrieved, unavailable, and stale data.
- **P0:** Allow users to refresh the information needed for an action and show what was refreshed.
- **P1:** Preserve useful prior observations during temporary failures, clearly marked with their age.
- **P0:** Present conflicting observations with their sources.
- **P0:** Distinguish Registry location from other location observations, and shared stocks from vessel cargo.

### Account access

- **P0:** Let players and administrators use their configured public accounts and credentials for the operations their roles permit.

### Server growth and partial availability

- **P0:** Open and use discovered places through consistent, capability-aware place views without a fixed panel or separate frontend for every server.
- **P1:** Search across connected sources and show search coverage and unavailable sources.
- **P0:** Show readable names and valid handles when known, with exact addresses available in details.
- **P0:** Base displayed identities, capabilities, availability, and geographical relationships on retrieved information.
- **P1:** Load detail on demand.
- **P0:** Keep other places and workflows usable when a source is slow or unavailable.
- **P1:** Prioritize automatic refreshes for active places and pending actions over unused sources.
