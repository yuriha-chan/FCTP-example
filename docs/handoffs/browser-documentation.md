# Browser documentation checkpoint

## Scope

Documented the current browser-backed CLI lifecycle, visible-control operations, role/session isolation, ref invalidation, rendered form values and secret masking, runtime config isolation, dependencies/build requirements, and gameplay/board/observer boundaries. Updated the client walkthrough to use the current session form. Added active-roleplay pointers while retaining historical API CLI provenance.

## Source findings

- The CLI supports `open`, `view`, `fill`, `select`, `click`, `submit`, `back`, `reload`, and `close`; it serves the generated real client bundle on an ephemeral loopback server and attaches one persistent detached Chromium session per role.
- Each operation returning a snapshot refreshes the opaque refs; stale refs error. Ordinary values are visible, while password/sensitive controls and known injected secrets are redacted.
- `FCTP_BROWSER_CONFIG_ROOT` isolates runtime config and role runtime files; compiled client/harness imports still resolve from the repository.
- Session application uses visible Role, Player URI, Vessel URI, Credential, Apply session controls. It clears the credential field and reports the identity without the secret. The old multi-admin-password instructions do not describe this session UI.
- `run/game.mjs` is retained as historical provenance/supervisor/archive tooling, not an alternate gameplay path for active roleplay. Board and observer/archive operations remain distinct interfaces.

## Verification facts recorded

- Generic DOM harness test passed.
- Actual Player-2 browser A production/load/current-berth departure and mandatory signed ExitEvent assertions passed.
- The spawned CLI test's corrected assertion awaits the final gate; that result is pending. Do not claim a final broad gate.
- Browser tests and the full gate were not run for this documentation checkpoint. Browser test execution requires the compiled build first.
- Host browser dependencies were installed by the user; the earlier installation blocker is historical, not current.

## Changed files

- Added `docs/browser-harness.md` and `run/manuals/browser.md`.
- Updated `docs/client-walkthrough.md`, `README.md` harness pointers only, `run/manuals/player.md` pointer/boundary only, and the historical status note in `run/browser-adapter.md`.
- Added this handoff. No roleplay prompt/access files, live services, roles, ticks, or commits were changed. No tests, type checking, ESLint, or UI checks were run because this was a documentation-only checkpoint and the assigned instruction prohibited browser tests/full gate.
