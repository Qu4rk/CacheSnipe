# Review ledger

## Round 1 — 2026-09-27 — initial review

- Reviewer actor: `codex-reviewer-20260927` (independent of builder `builder-01`).
- Contract: PLAN revision 1; base `a801bcf62afc68b49464c3499cb098717de66ad7`; reviewed HEAD is the same commit, with the complete uncommitted product diff in `src/store.ts`, `test/store.test.ts`, and `test/telemetry.test.ts`. No commits since base; `.quarkloop/` is coordination state. `check-git` reports `files_changed_since_review: []` because this is the first review.
- Review scope: all human-written changed lines in those three files, their surrounding store/test context, `StatsStore` public methods and `writeDerived`, `src/registry.ts` `markDirty`/`flush`, `src/telemetry.ts` `session.idle`, `src/testkit.ts`, and the atomic writer. No generated or data files changed. Repo standards checked in `package.json`, README, and local conventions; no `AGENTS.md`, `CONTRIBUTING.md`, CI workflow, or formatter policy found.

### Code-review / Standards (independent read-only axis)

- No documented-standard violations. The store edit retains atomic per-session writes, existing error logging, and local test conventions.
- **CR-STD-01 — possible Duplicated Code smell:** the local `emit` wrapper added at `test/telemetry.test.ts:96–98` repeats event construction already present near lines 67–69 and 125–127. A hook-input change would require multiple test edits. This is a small, self-contained fixture duplication, not a correctness finding.

### Code-review / Spec (independent read-only axis)

- The store change matches PLAN's pending-ID queue design and AC-01–03. No behavior contrary to the non-goals or scope was found.
- **CR-SPEC-01 — partial aggregate test evidence:** PLAN's Testing seams section asks for aggregate session IDs as part of the independent oracle. The new two-session tests assert parsed session files and counters, but do not assert that `aggregate.json` contains both IDs. No aggregate behavior defect was found.
- **CR-SPEC-02 — narrow retry assertion:** the AC-03 test checks persisted counter values and history length after retry, but does not compare full history contents. The changed production path does not mutate history; this is a test-strength observation.

### Quarkloop adjudication

- CR-STD-01 → **REV-01 [ADVISORY] [STANDARDS]** at `test/telemetry.test.ts:96–98`. Scenario: a future hook input shape changes. Impact: repeated test fixture edits; no current behavioral failure. Outcome: consolidate only if the fixture is touched again; no release block.
- CR-SPEC-01 → **REV-02 [ADVISORY] [SPEC / TEST QUALITY]** at `test/store.test.ts:108–134` and `test/telemetry.test.ts:92–119`. Scenario: session files persist but aggregate omits one ID. Impact: the new regressions would not detect that separate derived-report failure. An independent disposable probe in this review parsed `aggregate.json` and confirmed IDs `review_a` and `review_b`, plus B's original counter. AC-04 also has existing report tests and wirecheck. Outcome: add an aggregate-ID assertion when strengthening the tests; the required persistence outcome is verified.
- CR-SPEC-02 → **REV-03 [ADVISORY] [SPEC / TEST QUALITY]** at `test/store.test.ts:136–165`. Scenario: a future retry path changes history entries without changing length. Impact: this test would miss it. An independent disposable failure/retry probe compared exact history and notes plus `cacheRead` and `missInput`; all matched. Outcome: compare full history in the regression when revisiting it; no current defect.
- Open BLOCKER/REQUIRED findings: **0**. Disputes: none.

### Acceptance criteria

| Criterion | Verdict | Evidence |
|---|---|---|
| AC-01 | PASS | `flush(A)` deletes only A from `pendingFlush`; B remains for `flush()`. New on-disk two-session regression passes, and the independent aggregate probe confirms both IDs and B's counter. |
| AC-02 | PASS | `session.idle` calls `registry.flush(session)` for A; targeted store flush preserves B. Event-level test parses both session files and counters. |
| AC-03 | PASS | A write failure retains/adds its ID, logs a warning, and later `flush()` writes the record. Deterministic path-failure regression passes; independent probe confirmed exact history and notes and unchanged counters. |
| AC-04 | PASS | Existing single-session/report/retention/non-DeepSeek tests remain green; full suite 62/62 and wirecheck 40/40. Aggregate two-session probe passes. |
| AC-05 | PASS | Strict typecheck passes; product diff contains only the three PLAN-scoped files, with no generated/dependency/credential changes. |

### Independent verification and test quality

- `npm run build` → exit 0.
- `node --test dist/test/store.test.js dist/test/telemetry.test.js` → 26 passed, 0 failed.
- `npm run typecheck` → exit 0.
- `npm test` → 62 passed, 0 failed (base: 59 passed).
- `npm run wirecheck` → 40 passed, 0 failed (same count as base).
- `git diff --check` → exit 0; `git diff -- src/store.ts test/store.test.ts test/telemetry.test.ts` inspected in full; `check-git` confirmed exactly those product files and valid base ancestry.
- Disposable Node probe using `tempContext` (temporary directory only): two pending IDs, targeted A then full flush, parsed `aggregate.json` for both IDs and B's counter; then forced an atomic-write failure, restored the sessions directory, retried, and compared persisted counters, full history, and notes. All assertions passed. No product file was edited by the probe.
- `npm run verify` → exit 1, informational as PLAN specifies. It again reports the baseline historical turn-219 cold prefix, previously cached prefix re-sent, and three prefix breaks. This is the same recorded pre-existing failure and is assigned to a later initiative slice in DECISIONS.md; it is not evidence against this pending-flush change.
- The new tests use public store/event seams and parsed disk output, not private queue state or sleeps. The two-session tests would fail on the original unconditional queue clear because B's file would be absent; the builder recorded that red result (23/25 passing before the production edit). Reviewer did not alter the product diff to replay the red phase.

### Engineering and selected risk gates

- **Data integrity / partial failure:** atomic temp-file-and-rename remains unchanged; each successful ID is removed only after write success, and a failed ID stays pending for an explicit later flush. The warning remains observable. `updatedAt` changes on attempts as before; counters/history are not incremented by flush.
- **Concurrency / lifecycle:** scoped to distinct session IDs in one store instance as PLAN requires. Snapshotting pending IDs for a batch and deleting each after success preserves other queued IDs through a targeted flush. The debounce timer remains available; no busy retry loop was introduced. Same-session cross-process reconciliation is explicitly deferred.
- **Compatibility / scope:** no file schema, public API, dependency, README, installer, or generated artifact change. Temporary fixtures avoid network, credentials, billable requests, and user stats writes.
- Limit: this local review does not certify live OpenCode/DeepSeek caching behavior or the separate historical verifier defects; those are outside the frozen contract.

**Final verdict: APPROVED.** All required ACs are verified, mandatory gates pass, and no BLOCKER or REQUIRED finding remains. REV-01–03 are advisory and do not extend this run.
