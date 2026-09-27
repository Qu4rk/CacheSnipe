# Implementation evidence

## Round 1 — 2026-09-27 (builder-01)

- Head before work: `a801bcf62afc68b49464c3499cb098717de66ad7`, product tree clean (`.quarkloop/` untracked only).
- Scope attempted: PLAN vertical steps 1–3. Files changed: `src/store.ts`, `test/store.test.ts`, `test/telemetry.test.ts`. No other product edits.
- Failing signal (red on base, before `src/store.ts` edit):
  - `npm run build`, then `node --test dist/test/store.test.js dist/test/telemetry.test.js` → 25 tests, 23 pass, 2 fail.
  - `targeted flush preserves other pending sessions` → ENOENT `ses_b.json` missing.
  - `session.idle … does not discard another pending session` → ENOENT `ses_idle_b.json` missing.
  - Both failures match the PLAN probe (A persisted, B absent after `flush(A); flush()`).
- Production change (`src/store.ts` `flush`):
  - Removed upfront `pendingFlush.clear()`.
  - Delete ID only after `writeAtomic` succeeds; delete stale IDs with no in-memory record; on write failure `pendingFlush.add(id)` and keep warning log.
  - Preserves atomic temp+rename, `lastActive`/`writeDerived`, debounce timer, file layout, and report renderer. No new schema, retry loop, sleep, or dependency.
- Tests added (public seams only, temp dirs, no private-state inspection):
  - AC-01 `test/store.test.ts`: two dirty IDs, `flush(A)` then `flush()`, assert both parsed on-disk records with original counters/turns.
  - AC-02 `test/telemetry.test.ts`: two DeepSeek sessions via `message.updated`, `session.idle` for A, then explicit `store.flush()` drain, assert both files and counters.
  - AC-03 `test/store.test.ts`: replace `sessions/` with blocking file to force atomic-write failure, assert no record, restore dir, retry via `flush()`, assert original counters/turns/history length unchanged and `cachesnipe.log` contains `could not write session stats`.
  - Deduplicated overlapping regression names to one test per AC during self-review; final count is +3 tests vs base.
- Verification ladder (fresh, after fix):
  - `npm run build` → exit 0.
  - `node --test dist/test/store.test.js dist/test/telemetry.test.js` → 26 pass, 0 fail.
  - `npm run typecheck` → exit 0.
  - `npm test` → 62 pass, 0 fail (base 59 + 3 new).
  - `npm run wirecheck` → 40 passed, 0 failed (matches base).
  - `git diff --check` → exit 0, no whitespace errors.
  - `git diff -- src/store.ts test/store.test.ts test/telemetry.test.ts` → only the three scoped files, no generated files or credentials.
  - `npm run verify` (informational) → same pre-existing failure as base: turn 219 cold-prefix, prefix re-sent, 3 break alerts. No change vs PLAN baseline.
- Author self-review:
  - Read every changed line in diff + file context; checked `src/registry.ts` call sites (`flush(session)` → `markDirty` + `store.flush(id)`, `flushAll` → re-queue + `flush()`); error paths keep warn log and queue for later explicit flush/dirty event; no busy retry loop.
  - Each new test fails on base for the intended ENOENT/missing-record reason (AC-03 by construction: base clears queue on failure so retry drains nothing).
  - Removed duplicate regression names and unused `renameSync` import; kept `mkdirSync` (AC-03 restore) and `existsSync` (AC-02 file asserts) as minimal justified test imports.
  - No debug instrumentation, dead code, or unrelated formatting left.
- Deviations: none from frozen contract. No call-site change needed outside `src/store.ts`.
- Unresolved risks: cross-process same-session merge still deferred per DECISIONS.md; historical `verify` failures unchanged and out of scope.
- Head/dirtiness at handoff: HEAD `a801bcf62afc68b49464c3499cb098717de66ad7`, product dirty with `M src/store.ts`, `M test/store.test.ts`, `M test/telemetry.test.ts`. No commit (not authorized).
