# Worker test repair handoff

## Changed files and API

- `tests/host.test.ts`: replaced the timing-based repeated-error expectation with event-driven waits for the first and second worker errors. The second distinct poison Activity is enqueued only after the first error; assertions verify the first remains delayed while the second is processed. The test retains the named Actor, persisted key, key route, object signing, and worker-continuation assertions. Hosts close in `finally` blocks before temporary-directory removal.
- `docs/memos/worker-test-repair.json`: structured repair facts.
- No production files or exported APIs changed.

## Verification

- `npm run build && npm run typecheck:tests` — passed. Included TypeScript project builds, browser client compilation and bundling, test-source typechecking, and browser client typechecking.
- `npx tsx --test tests/host.test.ts` — passed: 1 test, 1 passed, 0 failed, 0 cancelled.
- `npx eslint tests/host.test.ts` — passed with no output.

## Findings

- Worker errors are awaited through bounded event-driven waits; the per-test timeout is 10 seconds and each wait has a 5-second failure bound.
- The first poisoned item is asserted to have a future `nextAttemptAt` both before and after the distinct second item reports its error, demonstrating continued worker processing while the first remains delayed.
