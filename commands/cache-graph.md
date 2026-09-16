---
description: DeepSeek cache hit-rate trend chart (CacheSnipe)
---

The pre-rendered CacheSnipe trend chart, injected verbatim:

!`cat "$HOME/.local/share/opencode/deepseek-cache/graph.txt" 2>/dev/null || echo "CacheSnipe: no chart yet. The plugin writes graph.txt after the first DeepSeek turn of a session."`

Instructions for you, the assistant:

1. Print the injected chart exactly as received, inside a single fenced code block. Preserve the bar characters, spacing, and column alignment; do not redraw or rescale it.
2. Then write one or two sentences interpreting the shape only: is turn 1 cold followed by a warm plateau (healthy), or does the hit rate fall or reset part-way (a prefix break, a compaction, or a model/agent switch)?
3. Do not call any tools and do not modify the chart file.
