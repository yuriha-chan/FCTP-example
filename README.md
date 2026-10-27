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
