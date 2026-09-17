---
description: Warm the DeepSeek disk cache for this session (CacheSnipe)
---

Run the CacheSnipe warm-up script so the next real turn starts from persisted
prefix units instead of paying cold. The script sends the session's own
baseline blocks twice (first send persists, second verifies) at temperature 0.

Instructions for you, the assistant:

1. Run this via your bash tool (no `--session` needed — it defaults to the most-recent session):
   `node "__CACHESNIPE_REPO__/scripts/warmup.mjs"`
   To warm a specific session, append `--session <id>`.
2. Report the two ping lines and the `warm verify` hit% in one sentence.
3. If the script reports no baseline blocks, say one sentence: send one real DeepSeek turn first, then warm.
4. Do not print the credential or the system prefix contents.

Note: this command intentionally sets neither `agent` nor `model`, so it appends
to the current session's history instead of starting a fresh cache chain. The
pings themselves go out-of-band over the DeepSeek API and only add this tool
result (a normal healthy extension) to the history.
