---
description: Business-oriented impact brief for analysts / project managers — effort, risk, downstream teams and a recommended decision, in plain language, no code
argument-hint: [symbol|file|--diff]
allowed-tools: Bash, Read, Grep, Glob
---

Impact brief requested on: $ARGUMENTS

Produce an **impact brief for a non-technical reader** (analyst, project manager, lead). This is not the developer report: **no file paths, no `file:line`, no symbol names, no regex, no code**. Translate the analysis into their language — scope, effort, risk, who is affected, and what decision is needed — and, above all, **explain the *why* in plain prose**. The numbers are facts; your job is to make them mean something.

## Step 1 — get a fresh analysis (do not invent numbers)

Delegate to the `impact-analyst` subagent, or run it yourself, so that `.impact/latest.json` exists and covers the target. If `$ARGUMENTS` is empty, analyze the current diff against `origin/main`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <A,B> --json
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --diff --base origin/main --json
```

Then **read `.impact/latest.json`**. Every figure in your brief must come from that file — never guess. Fields you will use: `risk`, `summary`, `symbols`, `topCallers`, `indirect`, `coupling`, `apiSurface`, `apiBreaking`, `irreversible`, `tests`, `crossRepo`, `externalConsumers`, `priorHints`, `changedFiles`.

## Step 2 — derive the business framing from the data

- **Affected areas.** Group the impacted files (`changedFiles`, the caller files in `topCallers`, and `indirect`) by their top one or two path segments (e.g. `src/Billing/…` → "Billing"). Report the list of *functional areas* touched and how many files in each — never the file list itself.
- **Effort / size.** Give a T-shirt size and justify it from scope, not vibes:
  - **XL** if `risk.level` is `blocking`;
  - **L** if `risk.level` is `high`, or `summary.callers >= 40`, or `crossRepo` is non-empty;
  - **M** if `risk.level` is `moderate`, or `summary.callers >= 15`, or `apiSurface` is non-empty;
  - **S** otherwise.
  State the driver ("L — a public contract changes and 3 downstream repos consume it"), and add the **testing load** (`tests.length` tests to run first) as part of the effort.
- **Downstream / teams.** From `crossRepo` and `externalConsumers`, name the consumer repos/services and, if a contact is declared, who to notify. This is the information nobody else can surface — lead with it when it exists.
- **Risk & required sign-offs.** From `irreversible`, translate each item into a business consequence in prose: destructive migration → *possible data loss, not reversible by a rollback of code*; payment/billing → *money movement*; email → *messages already sent cannot be recalled*; auth change → *access-control surface*. From `apiBreaking`, say *an existing public contract changes, so external consumers break unless updated*. If `risk.level` is `blocking`, state clearly that **human validation is required before deploy** and there is no override.
- **History.** If `priorHints` is non-empty, mention that this area has caused past incidents — a reason for extra care — while noting it is advisory context, not a verdict.

## Step 3 — write the brief

Structure it exactly like this, in prose (short paragraphs, not code):

```
Impact brief — <what is being changed, in plain words>

Bottom line: <RISK in plain terms> · Effort: <S/M/L/XL> · <one-sentence decision>

Why this size / this risk
<2–4 sentences explaining the drivers in human language: what areas it reaches,
why it is or isn't big, what makes it risky or safe. This is the heart of the
brief — be specific and causal, not a list of numbers.>

Areas affected
<functional areas + counts, e.g. "Billing (4 files), Orders (2), Notifications (1)">

Downstream & who to notify
<consumer repos / external consumers / contacts, or "none detected in scope">

Risk & sign-offs
<business consequences of the irreversible / breaking items, and whether human
validation is required before deploy>

Tests to cover it
<how many priority tests, and that the full suite is still required before merge>

Recommended decision
<go and implement · announce the scope first · lay out two options and let a human
choose · do not proceed without validation — in one or two sentences, in their words>
```

## Rules

- **Plain language, causal.** The value is the *why*, narrated for someone who does not read code. "This reaches Billing and two downstream services, and it changes a public API those services call — so it is medium-to-large and the mobile team must be told before release" beats any table.
- **Honesty about confidence.** Say "the analysis indicates" / "the report identifies", never "there are". Mention that indirect impact and name-based matches are heuristic, and that the analysis reduces uncertainty but does not replace running the tests.
- **Ground every number in `latest.json`.** If the data is empty (no symbol resolved, no history), say so plainly — an empty scope is itself information for an estimate.
- **Keep it short.** A brief is one screen. If it runs longer than ~25 lines, you are listing instead of explaining.
