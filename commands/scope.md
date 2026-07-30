---
description: Scope a not-yet-built feature from a spec — map each concept to a reusable anchor in the code or a net-new piece to build, with complexity and the decisions that block the work. For the implementer (agent or dev) and the tech lead.
argument-hint: <spec text | symbol,symbol,…>
allowed-tools: Bash, Read, Grep, Glob
---

Feature scope requested for: $ARGUMENTS

Build a **grounded scope map** for a feature that mostly does not exist yet. The reader is whoever will implement it — an **agent or a developer** — plus the tech lead who signs off. The goal is to ground the plan in the existing codebase: what can be **reused** vs what is genuinely **net-new**, so the build does not reinvent what is already there and does not assume reuse that the code does not support.

Do not assume a human writes the code. Size by building blocks and decisions, never by developer-hours.

## Step 1 — turn the spec into concrete concepts

Extract from `$ARGUMENTS` the concrete things the feature names: entities, screens/tabs, modules, workflows, integrations, data fields (e.g. "candidate status", "documents module", "internal messaging", "photo storage", "loge tags", "screenshot blocking"). If `$ARGUMENTS` is already a symbol list, use it as-is.

## Step 2 — search the codebase for each concept (grounded, never guessed)

Delegate to the `impact-analyst` subagent, or run the engine, so every classification is backed by a real search:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <Concept1,Concept2,…> --json
```

Read `.impact/latest.json`. For each concept:

- **Reusable anchor** — the symbol resolves (`declFile` present, or callers/coupling found). Note the anchor in plain terms (what it is, what it gives you). This is what to build on.
- **Net-new** — nothing resolves. It must be built from scratch.
- **Infeasible / needs a decision** — technically not reliably doable (e.g. blocking screenshots on the web) or contradicts an assumption in the spec.

Because resolution is name-based, an ORM-by-reflection or a differently-named class can hide a real anchor: flag every "net-new" as *"not found by name — confirm with someone who knows the screens"*.

## Step 3 — output the scope map

```
Feature scope — <feature name>

Size: <X reusable / Y net-new / Z infeasible-or-decision> · Complexity: <Low/Medium/High> (estimate)

Reuse (found in the code)
| Concept | Anchor to build on |
|---|---|
| … | … |

Net-new (build from scratch)
| Concept | Note |
|---|---|
| … | … |

Infeasible / needs a decision
- <concept> — <why: feasibility or a spec assumption the code does not confirm>

New data to add
- <fields/migrations the feature introduces, e.g. new dates on an existing entity>

Decisions that block the build (for the human)
- <the open questions that must be answered before an agent or a dev should start:
  unconfirmed reuse assumptions, architecture choices, legal/privacy, feasibility calls>

Measured vs estimated
- Measured (from latest.json): which concepts resolve in the code, callers, coupling.
- Estimated (judgment, to confirm): the net-new list, the complexity, feasibility.
```

## Sizing rules

- **Build scope (grounded):** count reusable anchors vs net-new pieces from Step 2.
- **Complexity (estimate):** **High** if ≥3 net-new subsystems or a hard feasibility/legal blocker; **Medium** if 1–2 net-new; **Low** if mostly reuse. Always label it an estimate.
- Never convert to developer-days. The cost driver is net-new subsystems and unresolved decisions, not who types the code.

## Rules

- **Ground everything** in the search output; a concept is "net-new" only after it failed to resolve, and even then flag it to confirm.
- **Separate measured from estimated** explicitly.
- The most valuable output is the **decisions that block the build** — surface them first when they exist.
