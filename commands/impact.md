---
description: Analyze the impact scope of a symbol, a file, or the current diff
argument-hint: [symbol|file|--diff]
allowed-tools: Bash, Read, Grep, Glob
---

Impact analysis requested on: $ARGUMENTS

Delegate to the `impact-analyst` subagent. It is read-only and works in its own context, which avoids polluting the main session with twenty call sites.

If `$ARGUMENTS` is empty, analyze the current diff against `origin/main`.

Pass the target to the agent as-is, without rephrasing it: a symbol name stays a symbol, a path stays a path.
