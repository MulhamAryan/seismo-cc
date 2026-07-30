---
description: Show breaking public-surface changes vs a base — removed or changed endpoints, DTOs, hubs
argument-hint: [--base <ref>]
allowed-tools: Bash, Read, Grep, Glob
---

Public API diff requested (base: $ARGUMENTS).

Delegate to the `impact-analyst` subagent. This query needs **diff mode with a base**: use the ref given in `$ARGUMENTS`, or `origin/main` if none is provided.

Ask it to run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --diff --base <ref> --short
```

and report **only the breaking public-surface changes** (`apiBreaking`): public elements that were **removed**, or whose signature/route sample **changed**. Additions are not breaking and must be omitted.

State the honest limitation up front: this is regex-based, not type-resolved — a parameter/signature change under the *same* route attribute is not detected, and a route rename surfaces as `removed` rather than `changed`.
