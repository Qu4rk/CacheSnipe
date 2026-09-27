# Decisions

## 2026-09-27 — Split the reliability initiative into reviewable runs

**Choice:** Make the pending-session persistence defect the only active contract. Sequence the remaining confirmed work as follows, creating a fresh Quarkloop plan for each independently testable slice:

1. **Active:** Preserve pending statistics when one session flushes or a write fails.
2. **Same-session cross-process integrity:** Investigate two `StatsStore` instances updating the same session ID, define duplicate-versus-distinct event identity, then fix or narrow the concurrency claim. Counter maxima alone do not prove convergence.
3. **Prefix-break accuracy:** Align a persisted trailing hash chain with the corresponding suffix of resumed histories; prove a long-session restart is an extension while real edits still break. Existing historical alerts with `history 100 -> 166/240/271` provide the regression shape.
4. **Compaction-aware verification:** Treat compaction as an explicit new cache segment in `scripts/verify.mjs` and rendered health metrics. Keep cache hit/miss accounting honest; do not describe a read-count decrement as measured tokens resent. Prove expected compaction passes and an unexplained cold reset fails.
5. **Installer correctness:** Make `--dry-run` read-only outside ignored build output, make `--stats-dir` actually configure the plugin and commands, and test idempotent JSON/JSONC patching in a temporary home.
6. **Pricing and claims:** Refresh model aliases and price handling against current official DeepSeek documentation, including peak/off-peak rates or explicit uncertainty; update README savings language and the 128-token caching explanation. Preserve provider-reported cost as distinct from estimated savings.
7. **Warm-up reliability:** Use the session's model and prove that a warm-up request produces a reusable prefix for the subsequent real model request, or narrow/remove the promise. No billable live test is authorized by this planning request.
8. **CI and compatibility:** Add GitHub checks for typecheck/tests/wirecheck and a supported Node/OpenCode version matrix after the behavior changes settle. Keep a manual live-provider smoke protocol for releases.

**Reason:** These areas have different failure modes, test seams, and review risks. The first slice is a reproducible data-loss defect and establishes trustworthy persisted records for later diagnostic changes.

**Alternatives rejected:** One broad run would mix persistence, pricing, installer, and provider behavior, making review and failure attribution weak. A documentation-only first run would leave the reproduced write loss in place.

**Consequence:** Completing the active run will not imply the later findings are fixed. Each later run gets its own frozen acceptance criteria and baseline. The project owner authorized planning these improvements; implementation has not been requested in this turn.

## 2026-09-27 — Defer same-session cross-process merging

**Choice:** Keep this run to multiple session IDs within one `StatsStore` instance. Track two processes updating the same session ID as a later investigation.

**Reason:** The current `mergeSessions` helper takes per-field maxima, while independent writers can overwrite each other's on-disk record. Correctly combining distinct and duplicate assistant events needs an event-identity rule; a quick counter sum could double-bill and is not justified by the pending-flush reproduction.

**Consequence:** The active ACs prove that one session's targeted flush does not drop another session's queued record. They do not certify all multi-process convergence claims in the README.
