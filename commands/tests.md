---
description: List the tests affected by a change — structural (reference the symbol) + historical (git co-change)
argument-hint: [symbol|file|--diff]
allowed-tools: Bash, Read, Grep, Glob
---

Affected-tests analysis requested on: $ARGUMENTS

Delegate to the `impact-analyst` subagent. It is read-only and works in its own context.

Ask it to run the analysis on the target and report **only the affected tests**: for each test file, its reason — `structural` (it references the changed symbol) or `historical` (it co-changed with the target in git) — and the exact command to run them.

If `$ARGUMENTS` is empty, target the current diff against `origin/main`. Pass the target to the agent as-is, without rephrasing it: a symbol name stays a symbol, a path stays a path.
