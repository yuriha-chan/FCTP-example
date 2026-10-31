# FCTP local demo

This Node 24 LTS / npm workspace runs a loopback demo with a Home/Registry authority, two distinct Territories, and a browser client at <http://127.0.0.1:4103>.

```sh
npm ci
npm test
npm run dev
```

`npm test` runs build, test-source typechecking, ESLint, and the runtime test suite. `npm run dev` builds and launches the demo (no watch mode). To build and launch the compiled CLI instead, run `npm run build` followed by `npm start`.

The launcher binds authority `4100`, Territory A/policy `4101`, Territory B/simulation `4102`, and client `4103`, all on `127.0.0.1`. Durable JSON stores and signing keys are written under `.fctp-data/`; set `FCTP_DATA_DIR` to choose another data directory. The directory persists across restarts.

Local administrator defaults are `demo-authority-admin`, `demo-policy-admin`, and `demo-sim-admin`. Override them with `DEMO_AUTHORITY_ADMIN_SECRET`, `DEMO_POLICY_ADMIN_SECRET`, and `DEMO_SIM_ADMIN_SECRET`, respectively. The client configuration publishes service origins and Actor IDs only; credentials are entered in the UI and are not put in public configuration or logs. The browser keeps entered credentials and the native token in memory only.

Start at <http://127.0.0.1:4103> and follow [the client walkthrough](docs/client-walkthrough.md). For active roleplay, use the [browser-backed role CLI](docs/browser-harness.md) and [run browser manual](run/manuals/browser.md); `run/game.mjs` is historical API provenance and supervisor/archive tooling, not a parallel gameplay path. The HTTP routes and authorization boundaries are documented in [the local API reference](docs/api.md). [Specification mapping](docs/spec-mapping.md), [implementation conventions](docs/implementation-conventions.md), and [known limitations](docs/limitations.md) distinguish local demo behavior from protocol requirements.

Player sessions also have a **Player creations** area for authoring text Assets and Variety definitions. The local native-auth API and public discovery/resource boundary are documented in [the local API reference](docs/api.md); the visible workflow is in [the client walkthrough](docs/client-walkthrough.md).

For independently operated Authority, Policy Territory, Simulation Territory, and Client containers, see the [separate Docker deployment guide](docs/deployment.md).

Another Player can read published Asset text through a Player's public `creations` collection. Text media controls attempt the public unauthenticated GET first; only a 401 or 403 with a native token falls back to the Actor-scoped read, and 404 or other failures remain visible. Territory A records Player-initiated mine, manufacture, transfer, load, and unload audit entries with the authenticated Player URI; entry prepare-vessel and departure exit-vessel record the verified Registry sender. A also accepts an optional local `varietyPortPolicy` map keyed by canonical Variety URI: a missing key allows load/unload, and `deny` rejects before mutation. This is local A policy, not an FCTP field, with no B equivalent. Authored Variety Production remains descriptive and is not executed or made portable.

A pre-game package under `run/harbor/` contains the advertisement, Arrivals guidance, out-of-character developer desk, participant reflection guidance, and observer reporting guidance. No world was launched and no ticks advanced; `run/` is excluded from Git, so the package is preparation only.
