---
description: Business impact brief for analysts / PMs / leads — reuse vs net-new, complexity, downstream, risk and the decisions a human must make. Plain language, no code. Works for a change OR a not-yet-built spec.
argument-hint: [symbol|file|--diff|<spec text>]
allowed-tools: Bash, Read, Grep, Glob
---

Impact brief requested on: $ARGUMENTS

Produce an **impact brief for a decision-maker** (analyst, project manager, lead). Not the developer report: **no file paths, no `file:line`, no symbol names, no regex, no code**. The reader decides and approves; they do not type the code — an agent may. So frame everything around **what has to be built vs reused**, **what is risky**, and **what a human must decide** — not around developer-hours.

## Step 0 — is this a change, or a not-yet-built spec?

- If `$ARGUMENTS` names an existing symbol / file, or is `--diff` → **change mode**.
- If `$ARGUMENTS` is a feature description (a spec, several sentences) → **greenfield mode**: nothing is built yet, so the diff is empty and the tool's risk/caller numbers will be ~zero. **Do not report a misleadingly small size from that.** Instead size the work by how many building blocks must be built vs reused (Step 2b).

## Step 1 — get grounded data (never invent numbers)

Delegate to the `impact-analyst` subagent, or run it yourself.

- **Change mode:** analyze the target (or the current diff vs `origin/main` if empty).
- **Greenfield mode:** extract the concrete concepts from the spec — the entities, screens, modules and integrations it names (e.g. "candidate status", "documents module", "internal messaging", "photo", "loge tags") — and search the codebase for each, so every claim is grounded, not guessed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <Concept1,Concept2,…> --json
```

Read `.impact/latest.json`. A concept whose symbol resolves (has a `declFile` / callers) is a **reusable anchor**; a concept that does not resolve anywhere is **net-new** (say so, and flag it "to confirm with someone who knows the screens" — reflection/ORM-by-name can hide a real anchor).

## Step 2 — separate what the tool MEASURED from what you ESTIMATE

State this split explicitly in the brief. It is the whole point of being honest:

- **Measured (deterministic, from `latest.json`):** callers, coupling, public surface, breaking changes, irreversible operations, cross-repo consumers, which concepts resolve in the code.
- **Estimated (your judgment):** the build size, the reuse-vs-net-new split, feasibility calls. Label these as estimates to confirm — never present them as tool output.

## Step 2b — size the work with BOTH scales

Give both, side by side, so the reader sees the shape:

1. **Build scope (grounded):** `X reusable anchors / Y net-new pieces / Z infeasible-or-needs-a-decision`, listing what each is in plain words.
2. **Complexity (estimate):** **Low / Medium / High** — High if ≥3 net-new subsystems or a hard feasibility/legal blocker; Medium if 1–2 net-new; Low if mostly reuse. Mark it "estimate, to confirm".

Do **not** translate this into developer-days: whether a human or an agent writes the code, the cost driver is the number of net-new subsystems and the decisions, not typing speed.

## Step 3 — write the brief (prose, one screen)

```
Impact brief — <what is being proposed, in plain words>

Bottom line: <risk in plain terms> · Build scope: <X reuse / Y net-new> · Complexity: <Low/Med/High, estimate> · <one-sentence decision>

Why this shape
<2–4 sentences: what already exists to build on, what is genuinely new, what makes
it risky or safe. The value is the causal why, in human language.>

Reusable vs net-new (grounded)
<the anchors found in the code, and the pieces that must be built from scratch>

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
