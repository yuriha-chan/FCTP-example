# Frontend technical requirements

## Purpose

Define the client architecture, retained state, application endpoints, and implementation responsibilities. User-facing workflows and priorities are defined in `frontend-requirements.md`.

## Architecture

Implement the client as a stateful web server with a browser frontend. The frontend and browser harness use the same client application API.

```text
Browser frontend ─┐
                  ├── Client application API
Browser harness ──┘           │
                              ├── Persistent client state
                              └── Client library ── World servers
```

| Component | Responsibility |
| --- | --- |
| Home server | Verify passwords, manage account availability through the home authority, issue native tokens, and derive diplomatic tokens and distribute their digests. |
| Other world servers | Publish resources and capabilities, perform world operations, and verify diplomatic authentication. |
| Client web server | Retain application state, resolve identities, coordinate retrieval and workflows, derive diplomatic tokens, make world-server requests, and supply page data and action results. |
| Browser frontend | Render structured page data, collect form input, and provide navigation and interaction. |
| Browser harness | Read page data and perform gameplay through the same client endpoints used by the frontend. |

The client web server owns durable application state. The client library supplies protocol operations. The browser does not need native tokens to render pages or submit actions to the client application.

### Replacement boundary

Deliver one frontend backed by the client application API. Replace the manual-session frontend; do not retain its screens, credential injection, direct world-request adapters, or compatibility branches as a parallel interface or fallback.

Retain required gameplay capabilities and protocol behavior in the application architecture, not the retired frontend's interfaces. Tests cover those capabilities through application contracts and browser interaction with the replacement. Remove tests whose sole purpose is compatibility with the retired frontend. Protocol, authentication, persistence, and generic browser-harness tests remain relevant independently of that interface.

Authoring, administration, journey execution, and direct harness integration remain their assigned implementation tasks. Incomplete workflows are not supplied by retaining the retired frontend.

## Persistence and session context

Persist the following in the client web server:

- Known servers and their authority relationships.
- Authority handles, Actor IDs, and roles.
- Accounts, home-server relationships, and per-account login state.
- Authoring drafts and saved route selections.
- Submitted action records, pending requests, and jobs being followed.
- Retrieved resources and observations, including source and retrieval time.

Page reloads and browser restarts retain this state. Retained observations describe what world servers reported; those servers remain responsible for world outcomes.

Keep the selected account and workspace as interface session context. Include the acting account explicitly in account-dependent API requests so separate browser or harness sessions do not change each other's acting identity through a global selection.

## Servers

Retain known servers independently of login state. Discovery adds servers to the client's known world rather than replacing a single current server. A successful login also adds the resolved Home authority and its server. Successful resolution of a Registry or Territory authority adds that authority and its server. The known list is shared across accounts.

| Field | Meaning |
| --- | --- |
| `server` | Canonical server address, including port where applicable: `domain:port`. |
| `origin` | HTTP(S) origin used for requests. |
| `authorities` | References to known authority Actors hosted by this server. |

Friendly display names are separate from network addresses.

## Authorities

An authority is an Actor with a discoverable handle and resolved Actor identity. Its role is separate from its identity.

| Field | Meaning |
| --- | --- |
| `handle` | Qualified authority handle, such as `@<name>.home@server`. |
| `actorId` | Resolved Actor URI. |
| `server` | Reference to the hosting server. |
| `roles` | Authority roles provided by the Actor. |

Retain the following authority roles:

| Role | Relationship retained by the client |
| --- | --- |
| Home authority | Manages account availability for accounts at the home server. |
| Territory authority | Authority associated with a particular Territory. |
| Registry authority | Authority associated with the relevant Registry and its resources. |
| Asset-server authority | Authority associated with an Asset server and its resources or publication destinations. |

Usually, one home authority account serves one home server. Represent that relationship explicitly rather than identifying the authority with the server address.

Allow an Actor to provide multiple authority roles. Retain authority relationships for the accounts, places, and resources to which they apply; these are not four application-wide authority selections.

## User accounts

Use `handle`, not `qualifiedUsername`, for the full account name.

| Field | Meaning |
| --- | --- |
| `handle` | Qualified user handle: `@<name>@server`. |
| `homeServer` | Reference to the server at which the account is registered. |
| `actorId` | Resolved user Actor URI, when available. |
| `homeAuthority` | Reference to the authority managing account availability. |

The same local name at different servers identifies different accounts. Retain accounts independently of login sessions: logout does not remove account identity or its home relationship.

Account availability is managed by the home authority. It is distinct from whether this client currently holds a login token and whether a server is reachable.

## Login state and native tokens

The client authenticates using a handle and password. The home server verifies the password against its stored password hash and issues a native token on successful authentication.

### Login flow

1. The user enters their account handle and password.
2. The frontend or harness submits the handle and password to the client web server.
3. The client web server identifies the home server from the handle and submits the login request to that server.
4. The home server verifies the password against its stored password hash and checks account availability.
5. On success, the client web server retains the issued native token in that account's login state and returns the public account/login result with a client session token.
6. On failure, the client returns the authentication error for display and correction.

The home server issues the native token. Retain login state per account rather than keeping one application-wide token.

| Field | Meaning |
| --- | --- |
| `account` | Reference to the account identified by its handle. |
| `homeServer` | Reference to the native token's issuing home server. |
| `nativeToken` | Native token obtained through login. |
| `status` | Signed in, signed out, or authentication rejected. |
| `expiresAt` | Token expiration when supplied by the server. |

The native token (`T`) stays in the client web server's account state and is never returned to the browser or harness. Successful `POST /api/accounts/login` returns the public account/login state plus a client session token (`S`). Account-scoped requests carry `Authorization: Bearer S` for the handle bound to that session. `GET /api/accounts` returns only the authenticated session's own account. Multiple `S` sessions may coexist for one account and across accounts; they are independent per login.

The browser stores per-account `{accountId, handle, clientToken}` sessions in `localStorage`, so a reload retains signed-in accounts. The CLI harness saves the same binding, with its origin, in a private `client-session.json` under the account runtime directory.

Logout deletes only the current `S`. When no session remains for that handle, the client login state becomes signed out. Logout does not revoke `T` at Home. Client sessions have no implicit expiry, and Home availability changes do not synchronize to existing sessions; neither behavior is promised.

Keep a separate active-account selection for the identity the user intends to act as. Switching the active account retains other accounts and their login states.

Connectivity failure and authentication rejection are separate conditions. A failed network request does not by itself mean the account has been signed out or made unavailable.

## Diplomatic authentication

Authenticated requests to other server endpoints require diplomatic tokens. Client derivation and Home derivation are complementary parts of the same flow:

1. The home server issues a native token.
2. The client web server derives the diplomatic token for the target resource-server Actor ID using `HMAC-SHA256(nativeToken, resourceServerActorId)`.
3. Home independently derives the same diplomatic token and distributes its digest to the resource server through the existing declaration mechanism.
4. The client web server presents the diplomatic token as a Bearer token when accessing that resource server.
5. The resource server verifies the presented token against the stored digest and applies resource authorization.

Here, client-side derivation means derivation by the client application's web server, not necessarily browser JavaScript.

- Keep native and diplomatic credentials distinct.
- Associate diplomatic authentication with the acting account and target resource-server Actor ID.
- Reuse the existing derivation, digest distribution, and verification mechanisms.
- Retrieve public resources without credentials first. On an authentication-required response (401/403), use the known target Actor audience for authenticated access.

## Relationships

```text
Server
  ├── hosts authority Actors
  └── serves as the home server for registered accounts

Authority Actor
  ├── has a handle and Actor URI
  ├── provides one or more authority roles
  └── is associated with relevant accounts, places, and resources

User account
  ├── has a handle and home server
  ├── is managed by its home authority
  └── has client login state with a home-server-issued native token

Client web server
  ├── retains known servers, authorities, and accounts
   ├── retains per-account login and working state
   └── derives diplomatic tokens for world-server requests
```

## Client behavior

- Add or discover a server without requiring login.
- Browse public places and resources before authenticating.
- Log in using an account handle and password; the client web server retains the home-server-issued native token and returns a client session token for account-scoped application requests.
- Show the acting account and the authority receiving an action.
- Switch accounts without discarding known servers or other login sessions.
- Log out of an account, removing only its current client session, while retaining discovered servers and public resource identities.
- Make server addresses and authority identities inspectable from connection details.

## Client application API

Provide page-oriented endpoints corresponding to the UI pages. Both the frontend and harness consume their structured responses. The client web server performs protocol resolution, authentication, world-server requests, and aggregation behind these endpoints.

### Page data

The following paths define the proposed client API. They are separate from world-server protocol endpoints. Resource identifiers in these paths refer to client records retaining the corresponding world identities.

| UI page | Endpoint | Page contents |
| --- | --- | --- |
| Overview | `GET /api/overview` | Holdings summary, pending matters, active work, and recent outcomes. |
| Explore / Places | `GET /api/explore/places` | Known places, geographical connections, and capability search results. |
| Explore / Place detail | `GET /api/explore/places/:placeId` | Place identity, authorities, capabilities, conditions, and connections. |
| Explore / Route | `GET /api/explore/routes/:routeId` | Origin, destination, legs, requirements, and known obstacles. |
| Logistics / Vessel | `GET /api/logistics/vessels/:vesselId` | Cargo, location observations, visits, movement, and available operations. |
| Production | `GET /api/production` | Places, supported operations, stocks, and jobs. |
| Production / Operation | `GET /api/production/operations/:operationId` | Inputs, quantities, capacity, permissions, blockers, and output destination. |
| Production / Job | `GET /api/production/jobs/:jobId` | Job state, progress, and observed outputs. |
| Author & Publish / Library | `GET /api/library` | Published and selected resources, with search and filtering. |
| Author & Publish / Draft | `GET /api/drafts/:draftId` | Draft fields, references, and preview information. |
| Resource reader | `GET /api/resources/:resourceId` | Readable content, identity, author, source, and resource references. |
| Activity | `GET /api/activity` | Action records and their outcomes. |
| Activity / Action | `GET /api/activity/:actionId` | Submission, resulting resources or requests, and subsequent observations. |
| Administration | `GET /api/administration` | Pending decisions, policies, and operational controls. |
| Administration / Request | `GET /api/administration/requests/:requestId` | Request details, decision context, and available decisions. |

Each page response supplies:

| Part | Contents |
| --- | --- |
| Context | Acting account and selected place, vessel, or resource. |
| Data | Structured display-ready page information, including readable identities. |
| Observations | Sources, retrieval times, and retrieval failures. |
| Actions | Supported actions, input requirements, known blockers, and their application endpoints. |

The frontend renders these data structures rather than interpreting raw protocol objects. It retains responsibility for layout, form interaction, and navigation. Search, filters, and account context are explicit request parameters where applicable.

### Actions

Use explicit mutation endpoints for user actions. Reads return retained page data; refresh actions retrieve new world observations.

| Action | Proposed endpoint |
| --- | --- |
| Discover a server | `POST /api/servers` |
| Refresh a place | `POST /api/explore/places/:placeId/refresh` |
| Plan and retain a route | `POST /api/explore/routes` |
| Request entry | `POST /api/logistics/vessels/:vesselId/entry-requests` |
| Depart | `POST /api/logistics/vessels/:vesselId/depart` |
| Load goods | `POST /api/logistics/vessels/:vesselId/load` |
| Unload goods | `POST /api/logistics/vessels/:vesselId/unload` |
| Traverse a selected route | `POST /api/logistics/vessels/:vesselId/traverse` |
| Submit production | `POST /api/production/operations/:operationId/execute` |
| Refresh a job | `POST /api/production/jobs/:jobId/refresh` |
| Create a draft | `POST /api/drafts` |
| Save a draft | `PATCH /api/drafts/:draftId` |
| Preview a draft | `POST /api/drafts/:draftId/preview` |
| Publish a draft | `POST /api/drafts/:draftId/publish` |
| Refresh resource content | `POST /api/resources/:resourceId/refresh` |
| Approve a request | `POST /api/administration/requests/:requestId/approve` |
| Reject a request | `POST /api/administration/requests/:requestId/reject` |
| Change a supported administrative control | `PATCH /api/administration/controls/:controlId` |

Action requests carry the acting account and the inputs needed for the operation. Responses supply an action record with:

- An action ID and a status endpoint under `/api/activity/:actionId`.
- The acting account, target, and submitted intent.
- Whether submission succeeded and a readable error when it failed.
- References to resulting requests, resources, or jobs.
- Whether the outcome is completed, pending, or not yet verified.
- Verified changes and observation times.

Submission and completion are separate states. The same action record follows an external decision or running job through subsequent observations.

### Accounts and connections

| Endpoint | Responsibility |
| --- | --- |
| `GET /api/accounts` | With `Authorization: Bearer S`, return only the authenticated session's own account identity and login status. |
| `POST /api/accounts/login` | Accept `handle` and `password`, authenticate with Home, retain the native token `T`, and return the public account/login state plus a client session token `S`. |
| `POST /api/accounts/:accountId/logout` | With `Authorization: Bearer S` for that account, delete only this client session; clear the client login state when no session remains. Does not revoke `T` at Home or remove the account identity. |
| `GET /api/servers` | Return known servers and authority relationships. |
| `POST /api/servers` | Accept a server address and discover and retain its public identities. |

Native tokens remain in the client web server's account state; account and page responses expose only the identity and login status needed by the frontend and harness. Account-scoped requests carry `Bearer S`, which is independent per login so concurrent sessions do not share credentials. The browser keeps sessions in `localStorage`; the harness persists its origin/handle-bound session in a private `client-session.json`. Client sessions do not implicitly expire, and Home availability changes do not synchronize to them.

## Implementation delta by layer

| Layer | Existing implementation | Required work |
| --- | --- | --- |
| World-server implementation | `apps/test-authority/src/home.ts` provisions, stores, and rotates native tokens and distributes token digests. | Add account password hashes, password verification, account availability state, and login-driven native-token issuance. Reuse diplomatic derivation and digest distribution. |
| World-server endpoints | Administrator-only `POST /local/home/issue` and `/local/home/rotate`; WebFinger and Actor reads; Home proxy and resource authentication. | Define and add a handle/password login endpoint returning the account identity and native token. Define and expose home-authority account availability management. These contracts are additions, not existing routes. |
| Shared libraries | `packages/auth` implements diplomatic derivation and digest creation; `packages/identity` provides WebFinger and Actor resolution. | Add common server/authority/account identity types, handle parsing, and world-login request/response contracts. Share client-application page/action contracts between its backend, frontend, and harness. |
| Client library | `packages/client-sdk` resolves identities and derives diplomatic credentials for a specified resource Actor. | Add Home login calls and reusable discovery/authentication operations. Keep protocol operations separate from client application persistence and page aggregation. |
| Client web server | Current client state is a single in-memory browser session; no stateful application backend provides the model above. | Implement persistence, account sessions, discovery catalogs, page-oriented API endpoints, action records, drafts, and workflow coordination using the client library. |
| Browser frontend | `apps/client` presents manual session configuration and raw-operation forms; public-first retrieval already exists. | Render page models and submit intent to client endpoints. Add handle/password login, account selection, and the planned discovery, logistics, production, authoring, and administration pages. Move world-request authentication and retained state into the client web server. |
| Browser harness | `scripts/browser.mjs` and `scripts/browser-worker.mjs` provision a browser session using account credentials and the manual session form. | Call client application endpoints directly for page data, login, account-scoped actions, and results. Adapt test-account setup for password login. Use browser automation for rendering and interaction verification. |

## Implementation dependencies

1. Specify the shared identity model and Home login/account-availability contracts.
2. Add Home password verification and login endpoints while retaining existing diplomatic authentication mechanisms.
3. Extend the client library to resolve handles and authenticate through those endpoints.
4. Implement the client web server's persistence, account state, and account/connection APIs.
5. Implement page reads and action endpoints in the per-requirement priority order from `frontend-requirements.md`.
6. Connect the frontend and harness to those same endpoints as each workflow becomes available.
