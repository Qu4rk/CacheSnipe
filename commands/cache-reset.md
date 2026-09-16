---
description: Archive and clear DeepSeek cache stats (CacheSnipe)
---

Clearing CacheSnipe stats. Session records are archived first, then removed:

!`d="$HOME/.local/share/opencode/deepseek-cache"; a="$HOME/.local/share/opencode/deepseek-cache-archive-$(date +%Y%m%dT%H%M%S)"; if [ ! -d "$d" ]; then echo "nothing to clear: $d does not exist"; elif [ -z "$(ls -A "$d"/sessions/*.json 2>/dev/null)" ]; then echo "nothing to clear: no session records in $d/sessions"; else case "$d" in "$HOME/.local/share/opencode/deepseek-cache") mkdir -p "$a" && cp -a "$d"/sessions/. "$a"/ && rm -f "$d"/sessions/*.json "$d"/summary.txt "$d"/graph.txt "$d"/aggregate.json && echo "cleared $d/sessions (archived to $a)" ;; *) echo "refusing to clear: unexpected stats path $d" ;; esac; fi`

Instructions for you, the assistant:

1. Print the single result line above verbatim.
2. Add one sentence confirming that only CacheSnipe files were touched, that the archive path holds the old records, and that the counters for the *currently running* session will repopulate as it continues (they are held in memory by the plugin).
3. Do not run any further shell commands, and do not try to delete the archive.

Notes: opencode's own data (`~/.local/share/opencode/opencode.db`, logs, snapshots) is never touched. The command archives rather than hard-deletes on purpose; remove the archive directory by hand if you really want it gone.
