# Nested Data Integrity proof interoperability checkpoint

## Scope and changed files

- `packages/identity/src/index.ts`: fixed FCTP context composition and term definitions used by signing.
- `tests/nested-proof.test.ts`: signed nested ExitEvent/Create and embedded EntryRequest regression coverage.
- `apps/territory-sim/src/territory.ts`: forwards the complete signed ExitEvent object without deleting its `@context`.
- `docs/handoffs/nested-proof.md`: this checkpoint.

No exported API, protocol schema, root configuration, Registry code, or Territory domain behavior changed.

## Diagnosis and repair

The pinned `@digitalbazaar/data-integrity` 2.5.0 `DataIntegrityProof.ensureSuiteContext` adds the Data Integrity v2 context; `canonizeProof` applies the signed document's context to the proof options. The pinned Data Integrity v2 context at `@digitalbazaar/data-integrity-context/contexts/data-integrity-v2.jsonld` declares `proof` in an `@protected` context. FCTP had redeclared that same term in its vocabulary context, as well as unconditionally appending FCTP to documents that could already carry it. When the signed ExitEvent's own context was processed inside a signed Create, this redefinition failed JSON-LD processing. FCTP no longer defines `proof`; the suite's protected definition remains authoritative. Context composition preserves existing context entries and adds FCTP only if absent.

FCTP's `vessel` term was typed as `@id`, although EntryRequest embeds a full Vessel object. It is now a normal FCTP property so JSON-LD canonicalization includes the embedded node and its fields. `data` now uses the JSON-LD `@json` type: Quantity.data is an opaque arbitrary JSON payload, so treating it as an ordinary untyped node could omit or reinterpret values during RDF canonicalization. The regression checks demonstrate that nested ExitEvent cargo data, EntryRequest cargo data, and embedded vessel capacity changes invalidate signatures.

Territory B now passes the complete host-signed ExitEvent to outbound delivery, retaining its generated `@context` and proof. The test signs an ExitEvent, embeds that exact object in a signed Create, verifies both proofs independently after JSON serialization roundtrip, and confirms cargo tampering invalidates both proofs.

## Verification

Commands ran sequentially:

1. `npm run build` — passed; package and application TypeScript build.
2. `npx tsx --test tests/nested-proof.test.ts` — passed, 2 tests; test source executed.
3. `npx eslint packages/identity/src/index.ts tests/nested-proof.test.ts apps/territory-sim/src/territory.ts` — passed; all changed TypeScript sources linted.

No blockers at this checkpoint.
