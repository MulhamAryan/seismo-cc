---
name: scope
description: Scope a not-yet-built feature from a spec — map each concept to a reusable anchor, cheap wiring on an existing pattern, or a genuine net-new subsystem, across sibling repos too. Separates build-complexity from blast-radius risk and from time. For the implementer (agent or dev) and the tech lead.
argument-hint: <spec text | symbol,symbol,…>
allowed-tools: Bash, Read, Grep, Glob
---

Feature scope requested for: $ARGUMENTS

Build a **grounded scope map** for a feature that mostly does not exist yet. The reader is whoever implements it — an **agent or a developer** — plus the tech lead. Ground the plan in the existing code: what is **reused**, what is **cheap wiring on an existing pattern**, and what is a **genuine net-new subsystem** — so the estimate is not inflated by counting a ten-line copy the same as a whole workflow.

## The three axes — never collapse them into one word

This is the rule that keeps the scope honest. Keep these **separate** and label each:

1. **Blast-radius risk** — how far a change to *existing* code ripples (callers, coupling, public surface, irreversible ops). For a not-yet-built feature this is essentially **nil** (there is no code to break yet). Do **not** report a diff-style "RISK: HIGH" for greenfield — it reads as "hard to code" and is wrong.
2. **Build complexity** — how much genuinely new machinery must be built. Driven by the count of **net-new subsystems** (see tiers below), NOT by how many concepts the spec lists.
3. **Effort** (only if asked) — time, under a named boundary (see the last section).

A dependency on another system or an unmade decision is a **coordination/decision risk**, not build complexity and not blast radius. Name it as such.

## Step 1 — turn the spec into concrete concepts

Extract the concrete things the feature names: entities, screens/tabs, modules, workflows, integrations, data fields (e.g. "candidate", "valve tab", "documents module", "internal messaging", "photo", "loge tags", "status sync", "screenshot blocking"). If `$ARGUMENTS` is already a symbol list, use it as-is.

## Step 2 — resolve each concept in the code (this repo AND siblings)

Run the engine so every classification is backed by a real search. **If the spec names another system** (a separate repo/service — e.g. an API the feature reads from) **or a workspace is configured**, add `--workspace <dir>` so concepts resolve across sibling repos too. A concept that lives in a sibling repo is **reuse (cross-repo)**, consumed via its API — not net-new. Skipping this is what produces a false "BLOCKING / everything is net-new" verdict.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <Concept1,Concept2,…> --json
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <…> --workspace <parent-of-sibling-repos> --json
```

Read `.impact/latest.json` (`symbols[]`, `topCallers`, `coupling`, `crossRepo`). Then classify each concept into one of **four tiers**:

| Tier | How to detect it (grounded) | Cost |
|---|---|---|
| **reuse** | the symbol resolves here — `declFile` present / `callSites > 0` | ~0 |
| **reuse (cross-repo)** | resolves in a sibling repo (`crossRepo`), consumed via API, not reimplemented | ~0 to build; coordination cost noted separately |
| **wiring** | does NOT resolve, **but a same-kind sibling does** and the new piece is a copy of it (e.g. a new `GetByStatus` endpoint next to an existing `GetAllUsers`; a new Business method next to an existing Business class) | low — minutes to an hour |
| **net-new subsystem** | no local anchor, no sibling to copy, no existing pattern (e.g. a whole new workflow, a sync mechanism where no event infra exists, photo upload where none exists) | real |

For every "net-new", say whether it is really a **subsystem** or just **wiring** — this is the single biggest source of over-estimation. And flag each unresolved concept "not found by name — confirm with someone who knows the screens" (ORM-by-reflection / a differently-named class can hide a real anchor).

## Step 3 — output the scope map

```
Feature scope — <feature name>

Reuse: <n>  ·  Wiring: <n>  ·  Net-new subsystems: <n>  ·  Infeasible/decision: <n>
Build complexity: <Low/Medium/High> (estimate) — counts net-new SUBSYSTEMS only
Blast-radius risk: <Low for greenfield> — nothing to break yet; the real risk is coordination/decisions

Reuse (found in the code)
| Concept | Anchor (here or cross-repo) |
|---|---|

Wiring (copy an existing pattern)
| Concept | Sibling it copies |
|---|---|

Net-new subsystems (no pattern to copy)
| Concept | Why it is genuinely new |
|---|---|

Infeasible / needs a decision
- <concept> — <feasibility, or a spec assumption the code does not confirm>

New data to add
- <fields/migrations, e.g. new dates on an existing entity>

Decisions & external dependencies that block the build (for the human, first)
- <unmade architecture/feasibility/privacy calls, and dependencies on other systems/teams
  — these drive coordination risk, NOT coding difficulty>

Measured vs estimated
- Measured (from latest.json): which concepts resolve, where (here / sibling), callers.
- Estimated (judgment, to confirm): the wiring-vs-subsystem calls, complexity, feasibility.
```

## Sizing rules

- **Build complexity (estimate):** **High** if ≥3 **net-new subsystems** or a hard feasibility/legal blocker; **Medium** if 1–2 net-new subsystems; **Low** if mostly reuse and wiring. **Wiring and cross-repo reuse do NOT count as subsystems** — that is the fix for equal-weighting a ten-line copy with a whole workflow.
- Blast-radius risk is reported **separately** and is Low for greenfield by construction.

## If asked for a time estimate — name the boundary

The tool does not volunteer developer-days, but if the user asks, give a bounded number and **state the boundary explicitly** (this prevents the endless "does it include deployment?" argument):

> **Estimation boundary:** `git checkout` → `git push`, by a developer who already knows the repo — writing code + local tests + commit. **Excludes** deployment, applying a migration in production, end-to-end acceptance/recette, and cross-team coordination.

Under that boundary, size from tiers: reuse/wiring are minutes–hours, net-new subsystems are the real cost. Do not fold deploy/migration-in-prod/recette into the number — call those out as separate, out-of-boundary work. If the boundary is not stated, do not give a number.

## Rules

- **Ground everything** in the search output (this repo + siblings). "Net-new" only after it failed to resolve everywhere, and even then flag it to confirm.
- **Keep the three axes separate.** Most confusion comes from calling a coordination/decision risk "HIGH complexity".
- The most valuable output is the **decisions & external dependencies that block the build** — surface them first.
