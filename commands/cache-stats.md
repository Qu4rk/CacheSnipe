---
description: DeepSeek cache hit stats (CacheSnipe)
---

The CacheSnipe report file, injected verbatim. Its "this session" block is the
session whose turn completed most recently (reports are shared files, so the
session id is printed: read it rather than assuming):

!`cat "$HOME/.local/share/opencode/deepseek-cache/summary.txt" 2>/dev/null || echo "CacheSnipe: no report yet. The plugin writes summary.txt after the first DeepSeek turn of a session."`

Instructions for you, the assistant:

1. Print the injected output exactly as received, inside a single fenced code block. Do not re-order, round, re-label, abbreviate, or "improve" any number.
2. Then write at most two sentences. Treat `prefix lost` above 0, any prefix breaks, or `prune` enabled as faults: name the single most likely cause and the one thing to check first. The hit rate is context, not a verdict: every turn also uploads its own new content (tool output plus your message), which cannot be cached, so it sits below 100% even when the prefix is perfect. Do not report that as a problem. Otherwise say the cache is healthy and stop.
3. Do not call any tools and do not modify the report file.

Note: this command intentionally sets neither `agent` nor `model`, so it appends to the current session's history instead of starting a fresh cache chain.
