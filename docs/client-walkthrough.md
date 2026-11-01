# Browser client walkthrough

Start the local demo with `npm run dev` and open <http://127.0.0.1:4103>. The same client is served by the demo's client server and by the application origin configured for the [browser harness](browser-harness.md). The client application retains accounts, drafts, route plans, actions, and sourced observations in `client.store.json` under the chosen data directory.

## Sign in

Use the **Accounts** section's **Handle** and **Password** fields. Home verifies the password; the client application retains the Home-issued native token and presents only public account state. A successful login also returns a client session token (`clientToken`). The browser stores per-account `{accountId, handle, clientToken}` sessions in `localStorage` and sends `Authorization: Bearer <clientToken>` on account-scoped application requests for that handle. The native token stays in the client web server and is never sent to the browser. Select a signed-in account to scope Explore, Author & Publish, Logistics & Production, Activity, and Administration.

Sign in separately for each account; sessions for different handles are independent, and multiple sessions for one account may coexist.

The demo fixture provides development accounts described in the [browser harness guide](browser-harness.md#start-the-local-demo). Sign in with the handle and password; the browser does not need a manually copied native token or a role-specific session form.

## Log out

Log out of an account from its **Log out** control. This removes only the current browser session for that account. When no client session remains for the handle, the client login state becomes signed out; discovered servers and public resource identities remain. Logout does not revoke the Home native token. Client sessions do not implicitly expire, and disabling an account at Home does not synchronize to an existing session.

## Discover and use visible actions

Use **Connections** to discover a public server origin or resolve an authority handle. Discovered server and authority records are retained. A successful login also retains the resolved Home server and Home authority. Explore and Logistics use those retained records; explicit refresh reads the relevant world services.

Accounts, server discovery, action results, geography, authoring, logistics, production, and administration all work through the client application API. Page reads use retained state. A successful request or delivery acknowledgement does not by itself establish a Territory business outcome; refresh the relevant action or observation to see pending, completed, rejected, or unverified state.

The exact current controls, options, disabled states, and refs are in each live DOM snapshot. Use [the browser harness guide](browser-harness.md) for snapshot and ref handling.

## Player creations

With a signed-in Player selected, use **Author & Publish** to create a text Asset with its **Draft name** and **Draft text**, or a Variety with **Draft name**, **Mass**, **Version**, optional own **Asset reference URI**, and optional Production entries. The Production editor offers structured fields for mining/manufacturing, ingredients, locations, tools, duration, and yields, plus an advanced JSON mode for accepted extension fields and unusual payloads. Only the selected mode is submitted; drafts remain available when switching modes.

Mass may be fractional and positive. Production defaults to `[]` and is descriptive data only; creating a Variety does not install a Territory rule or generate cargo. A same-Player Asset selection creates an AssetGrant linking that Asset to the Variety. Publication returns the exact Asset and Variety identities. Asset text is displayed as text, not interpreted as HTML.

Published objects, the Actor's `creations` collection, Outbox entries, and Asset text media are public resources even though the local authoring catalog is scoped to the authenticated Player. Loading another Player's `Published Player creations` collection adds `Asset text` controls; each attempts the public unauthenticated media GET first, falls back to an Actor-scoped read only on `401` or `403` with a native token, and keeps `404` or other failures visible. See the [Production authoring FAQ](authoring-faq.md).

## Logistics, production, and administration

Explore carries the selected place and route identities into **Logistics & Production**. Refresh the vessel to retain Registry and Territory observations, or refresh production to retain operation and job observations for that vessel and account. Mine, manufacture, transfer, load, and unload operations are advertised by their responsible Territory; the client submits only an enabled operation and its declared inputs.

Policy production completes through immediate local actions. Simulation production and cargo handling return jobs that progress as the simulation tick advances. Only a bound administrator can change policies, facilities, admission review, or tick state. Manual review decisions use the selected administrator account's exact binding. Supported administration controls and their current targets are visible in **Administration**.

Restarting the demo with the same data directory recovers accounts, drafts, route plans, pending actions and jobs, and retained observations without resubmitting requests. Reads of retained pages do not contact world services; refresh is explicit.
