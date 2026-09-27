# Plan: Preserve CacheSnipe session statistics across concurrent flushes

Run: `20260927000927-preserve-cachesnipe-session-statistics-acros`
Base: `a801bcf62afc68b49464c3499cb098717de66ad7`
Contract revision: 1

## Origin and goal

On 2026-09-27 the project owner asked for a Quarkloop plan covering fixes and improvements identified in the CacheSnipe audit. This is the first slice of the reliability initiative recorded in `DECISIONS.md`. Its observable outcome is that flushing one DeepSeek session does not discard another session's pending statistics, including when an atomic write fails. The fix must preserve the existing on-disk session format and report behavior.

## Non-goals

- Do not change cache-prefix transforms, pricing, installer behavior, warm-up requests, or the independent SQLite verifier in this run. Those are separate initiative slices.
- Do not redesign reconciliation when two *processes* write different updates to the same session ID. That needs a separate event-identity and merge contract; this run covers multiple sessions managed by one store instance.
- Do not install the plugin, alter the owner's OpenCode configuration or historical data, or send billable DeepSeek requests.
- Do not add dependencies, commit, push, or publish.

## Repository evidence

- `src/telemetry.ts` handles `session.idle` by calling `registry.flush(session)`; `src/registry.ts` forwards this to `StatsStore.flush(sessionID)`.
- `src/store.ts` uses a `pendingFlush` set and a debounced `flush()`. At base, `flush(sessionID)` selects only that ID and then clears the **entire** set before writing. `flushAll()` schedules all in-memory sessions; writes use a temp file and rename.
- `test/store.test.ts` covers a single-session roundtrip and a pure `mergeSessions` helper, but not two pending IDs or a failed write. `test/telemetry.test.ts` covers usage and idle behavior.
- A temporary-directory reproduction at base created and marked `ses_a` and `ses_b` dirty, called `flush('ses_a')`, then `flush()`: `aPersisted=true`, `bPersisted=false`. The reproduction used only the compiled `tempContext` test fixture and no user data.
- The checked-out `main` was clean at run creation. No repository `AGENTS.md` or CI workflow is present. Node is v26.4.0; the package requires Node >=22.

## Baseline health

Fresh commands on base `a801bcf`:

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | Strict TypeScript check passed. |
| `npm test` | 0 | 59 passed, 0 failed. |
| `npm run wirecheck` | 0 | 40 passed, 0 failed against the compiled hook surface. |
| `npm run verify` | 1 | Pre-existing historical-session failure: a documented compaction at turn 219 is treated as a cold-prefix failure; three recorded break alerts also remain. This is outside this slice and is not a release gate for it. |
| Two-pending-session reproduction | 0 (probe) | A was persisted; B was absent after targeted and subsequent full flush. This is the red behavior the regression test must capture. |

## Invariants and risks

- Keep atomic replacement for each session JSON file. Never mark an ID clean before its write succeeds.
- A targeted flush may complete independently while other IDs remain eligible for the existing debounced flush; no retry loop or arbitrary timer sleep is needed.
- Preserve counters, history, notes, retention behavior, aggregate/summary/graph generation, and the `session.idle` contract. A retry must not duplicate or reset a record.
- Write errors remain logged and recoverable on a later explicit flush or subsequent dirty event. A persistent permissions error must not create a busy retry loop.
- All tests use temporary directories; no credentials, historical OpenCode records, network calls, or new dependencies enter fixtures.

## Design

Treat `pendingFlush` as a queue of IDs whose current in-memory records are not yet durable. A targeted flush attempts only its ID. A full flush attempts the pending IDs present at its start. Remove an ID from the queue only after `writeAtomic` succeeds; leave it queued after failure for a later explicit flush or dirty event. A queued ID with no in-memory record can be dropped as stale. Keep the existing debounce mechanism, file layout, and report renderer. In particular, a targeted `session.idle` flush must leave the timer and other pending IDs available for the later batch.

This is the smallest seam that fixes the reproduced loss without changing telemetry accounting or inventing cross-process merge semantics.

## Testing seams

- Exercise the public `StatsStore.put`, `markDirty`, `flush`, and `flushAll` methods in a temporary directory. The independent oracle is the actual session JSON files and their parsed counters, plus the aggregate's session IDs; tests must not inspect the private pending set.
- Exercise the `session.idle` event handler once with two active DeepSeek sessions, then explicitly drain the store. Verify both files exist, rather than asserting an internal callback ran.
- Force one session write to fail by temporarily making the temporary `sessions` path unusable; restore it, explicitly retry, and verify the original record is persisted. Avoid sleep-based timing.

## Acceptance criteria

- **AC-01 REQUIRED:** With two dirty session IDs, targeted `flush(A)` persists A and a later `flush()` persists B with its original values. Evidence: a regression test checking both parsed on-disk records, red on base and green after the fix.
- **AC-02 REQUIRED:** A `session.idle` event for A cannot discard B's pending statistics; the later drain persists both. Evidence: an event-level regression test using `tempContext` and parsed session files.
- **AC-03 REQUIRED:** A failed atomic write leaves that session eligible for a later successful flush, logs a warning, and does not duplicate its counters/history. Evidence: deterministic temporary-path failure and retry test.
- **AC-04 REQUIRED:** Existing single-session roundtrip, derived report, retention, and non-DeepSeek behavior stay intact. Evidence: focused tests plus the full unit suite and wire check.
- **AC-05 REQUIRED:** TypeScript remains strict-clean, with no changed product files beyond the store, directly relevant tests, and any minimal call-site adjustment justified by the regression. Evidence: `npm run typecheck` and diff inspection.

## Vertical implementation steps

1. Add a two-pending-session regression to `test/store.test.ts` and an idle-event regression to `test/telemetry.test.ts`; run the focused tests and record the expected base failure. Stop if the failure does not reproduce the observed missing B file.
2. Make the smallest change in `src/store.ts` so successful writes clear only their IDs and failed writes remain pending. Add the deterministic failure-and-retry case. Stop if the change requires a new persistence schema or broad telemetry rewrite; return to PLAN.
3. Run the focused checks, typecheck, full unit suite, and wire check. Inspect every changed product line and compare results with the baseline. Record evidence and remaining risks in `IMPLEMENTATION.md` before review.

## Verification matrix

| Stage | Exact command / check | Expected result and stop condition | Review gate |
|---|---|---|---|
| Focused build/tests | `npm run build`, then `node --test dist/test/store.test.js dist/test/telemetry.test.js` | New regressions fail before the fix, then all focused tests pass after it; target 30 s each. | Mandatory |
| Static | `npm run typecheck` | Exit 0; target 30 s. | Mandatory |
| Full regression | `npm test` | Exit 0 with no failures; target 30 s. | Mandatory |
| Plugin integration simulation | `npm run wirecheck` | Exit 0, 0 failed; target 30 s. | Mandatory |
| Diff/scope | `git diff --check` and inspect `git diff -- src/store.ts test/store.test.ts test/telemetry.test.ts` | No whitespace errors, unrelated product edits, generated files, or credential data. | Mandatory |
| Historical live verifier | `npm run verify` | Known pre-existing failure; do not use as an approval gate for this slice. Any change in its result should be investigated, not presumed caused by this run. | Informational |

No live DeepSeek smoke test is needed for this local persistence correction; the later integration slice will specify one if configuration and billable-call authority are available.

## Open decisions

None for this slice. Cross-process same-session reconciliation is explicitly deferred pending a separate contract, not silently treated as fixed here.
