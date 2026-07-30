---
description: Business impact brief for analysts / PMs / leads — reuse vs net-new, complexity, downstream, risk and the decisions a human must make. Plain language, no code. Works for a change OR a not-yet-built spec.
argument-hint: [symbol|file|--diff|<spec text>]
allowed-tools: Bash, Read, Grep, Glob
---

Impact brief requested on: $ARGUMENTS

Produce an **impact brief for a decision-maker** (analyst, project manager, lead). Not the developer report: **no file paths, no `file:line`, no symbol names, no regex, no code**. The reader decides and approves; they do not type the code — an agent may. So frame everything around **what has to be built vs reused**, **what is risky**, and **what a human must decide** — not around developer-hours.

## Step 0 — is this a change, or a not-yet-built spec?

- If `$ARGUMENTS` names an existing symbol / file, or is `--diff` → **change mode**.
- If `$ARGUMENTS` is a feature description (a spec, several sentences) → **greenfield mode**: nothing is built yet, so the diff is empty and the tool's risk/caller numbers will be ~zero. **Do not report a misleadingly small size from that, and do not report a diff-style "RISK: HIGH" either** — for a not-yet-built feature the blast-radius risk is essentially nil (there is no code to break). Size the work by how many building blocks must be built vs reused (Step 2b), and keep that separate from risk.

**Keep three axes separate — never collapse them into one word:** (1) **blast-radius risk** (how far a change to existing code ripples — ~nil for greenfield), (2) **build complexity** (how much genuinely new machinery — counts net-new *subsystems*, not every concept), (3) **effort** (time, only if asked, under a named boundary). A dependency on another system or an unmade decision is a **coordination/decision** matter, not build complexity and not blast radius.

## Step 1 — get grounded data (never invent numbers)

Delegate to the `impact-analyst` subagent, or run it yourself.

- **Change mode:** analyze the target (or the current diff vs `origin/main` if empty).
- **Greenfield mode:** extract the concrete concepts from the spec — the entities, screens, modules and integrations it names (e.g. "candidate status", "documents module", "internal messaging", "photo", "loge tags") — and search the codebase for each. **If the spec names another system** (a separate repo/service the feature reads from) or a workspace is configured, add `--workspace <dir>` so concepts resolve across sibling repos too — a concept that lives in a sibling is **reuse (cross-repo)**, not net-new. Skipping this produces a false "everything is net-new / BLOCKING" verdict.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <Concept1,Concept2,…> --json
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <…> --workspace <parent-of-sibling-repos> --json
```

Read `.impact/latest.json` (`symbols[]`, `crossRepo`). Classify each concept into: **reuse** (resolves here), **reuse (cross-repo)** (resolves in a sibling), **wiring** (does not resolve but a same-kind sibling does and the new piece is a copy of it — e.g. a new endpoint next to an existing one — cheap), or **net-new subsystem** (no anchor, no pattern to copy — real). Flag every unresolved one "to confirm with someone who knows the screens" (reflection/ORM-by-name can hide a real anchor).

## Step 2 — separate what the tool MEASURED from what you ESTIMATE

State this split explicitly in the brief. It is the whole point of being honest:

- **Measured (deterministic, from `latest.json`):** callers, coupling, public surface, breaking changes, irreversible operations, cross-repo consumers, which concepts resolve in the code.
- **Estimated (your judgment):** the build size, the reuse-vs-net-new split, feasibility calls. Label these as estimates to confirm — never present them as tool output.

## Step 2b — size the work with BOTH scales

Give both, side by side, so the reader sees the shape:

1. **Build scope (grounded):** `<reuse> reused / <wiring> wiring / <subsystems> net-new subsystems / <n> infeasible-or-decision`, listing what each is in plain words. Wiring and cross-repo reuse are cheap — do not lump them with net-new subsystems.
2. **Complexity (estimate):** **Low / Medium / High** — High if **≥3 net-new subsystems** or a hard feasibility/legal blocker; Medium if 1–2 net-new subsystems; Low if mostly reuse and wiring. **Count net-new subsystems only** — a ten-line copy of an existing pattern is wiring, not a subsystem. Mark it "estimate, to confirm".

And report **blast-radius risk separately** — Low for greenfield, because there is no existing code to break. Do not merge it into complexity.

If the user asks for a **time estimate**, give a bounded number and **state the boundary**: `git checkout → git push`, by a developer who already knows the repo (code + local tests + commit) — **excluding** deployment, applying a migration in production, acceptance/recette, and cross-team coordination. Size from the tiers (reuse/wiring = minutes–hours, net-new subsystems = the real cost). If the boundary is not stated, do not give a number.

## Step 3 — write the brief (prose, one screen)

```
Impact brief — <what is being proposed, in plain words>

Bottom line: Build complexity <Low/Med/High, estimate> · <reuse>+<wiring> reused/wired, <subsystems> net-new · Blast-radius risk <Low for greenfield> · <one-sentence decision>

Why this shape
<2–4 sentences: what already exists to build on (here and in sibling repos), what is
just wiring on an existing pattern, what is genuinely new, and what the real risk is
— usually a coordination/decision matter, not coding difficulty. Causal, in human language.>

Reused / wiring / net-new (grounded)
<the anchors found (here or cross-repo), the cheap wiring copies, and the genuine
net-new subsystems — kept distinct so the size is not inflated>

Downstream & who to notify
<consumer repos / external consumers / contacts, or "none detected">

Risk & what a human must decide
<business consequences (data loss, money, emails, personal/sensitive data, legal),
plus the calls only a human should make: architecture, feasibility (e.g. "web
cannot truly block screenshots — dissuasion only"), and any reuse assumption in the
spec that the code does NOT confirm.>

Recommended decision
<go / announce scope first / decide the open questions before estimating / do not
proceed without validation — one or two sentences.>
```

## Rules

- **Plain, causal language.** Explain the *why* for someone who does not read code.
- **Honesty about confidence.** "The analysis indicates / the report identifies", never "there are". Name-based search and greenfield concept matching are heuristic; the analysis reduces uncertainty, it does not replace building and testing.
- **Empty scope is information.** A spec with no existing code to change is not "small" — say plainly it is mostly net-new, and size it by the building blocks.
- Keep it to one screen.
