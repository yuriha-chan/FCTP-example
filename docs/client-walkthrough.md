# Browser client walkthrough

For role sessions, use the browser-backed CLI in [the browser harness guide](browser-harness.md). It opens the same HTML/JavaScript client served to people in a browser; it does not send gameplay requests itself. The standalone demo can also be started with `npm run dev` and opened at <http://127.0.0.1:4103>.

## Apply a browser session

The page has one **Browser session** form with **Role**, **Player URI**, **Vessel URI**, and **Credential** fields, followed by **Apply session**. Select `Player` and supply that Player's own Player and Vessel URIs plus native credential. The three administrator roles are `Policy administrator`, `Simulation administrator`, and `Authority administrator`; each takes its assigned service credential. Applying the form clears the password field and reports the selected session without displaying its credential. Credentials are held in page memory; reloading a direct browser page clears them.

## Discover and use visible actions

After applying a Player session, refresh **Registry**, **Territory A**, or **Territory B** in **Current state and available actions**. Review the displayed current state, effects, unavailable reasons, and request details. Select an enabled advertised action to submit it through the client. The client reports pending/error status and refreshes the associated view; an accepted request or delivery acknowledgement alone does not establish a Territory business outcome. Refresh state again when checking later outcomes.

The other visible sections provide Actor/resource retrieval, Registry entry/departure and signed ExitEvent verification, A's immediate production and vessel cargo controls, and B's scheduled production/cargo jobs. B jobs progress only when its administrator advances ticks. Administrative policy, facility, and tick controls are shown for their assigned role. The exact current control labels and refs are in each live CLI snapshot; see [the browser harness guide](browser-harness.md) for operating them safely.

This walkthrough describes the current session form and role-scoped controls. The older multi-password Test authority login and administrator input instructions are not the browser session setup.
