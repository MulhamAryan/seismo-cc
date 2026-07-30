---
name: impact-analysis
description: Decides when to analyze the impact scope of a change and what to do with the verdict. Use this skill systematically whenever a task involves modifying existing code — bug fix, refactoring, rename, signature change, database migration, endpoint or DTO change, version bump — and whenever the user asks for an estimate, asks "what does this break", "what is the impact", "is it risky", or before opening a pull request. Do not use it for entirely new code with no consumer.
---

# Impact analysis: when to trigger, what to do with the verdict

The dominant cost in maintenance is not writing the code: it is not knowing what you touch. This skill serves to know the scope before modifying it, and to stop when the scope exceeds the mandate.

This skill does not do the analysis itself. It decides **when** to request it and **how** to act afterward.

## Delegate, don't analyze yourself

Launch the `impact-analyst` subagent via the Task tool. It is read-only, works in its own context, and returns about fifteen lines.

This is the whole point of delegation: reading twenty call sites to extract three useful lines should burn *its* context, not yours. Doing the analysis live in the main session works too, but you pay for that context throughout the rest of the task — and it is precisely the context you will need to implement.

Two exceptions where a direct call is justified: checking a single symbol when you already have the file in front of you, or the subagent being unavailable.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --symbols <A,B> --short
node "${CLAUDE_PLUGIN_ROOT}/bin/impact.js" analyze --diff --base origin/main --short
```

### Which model to run the analyst on

The default is set once, in the analyst's config: `model: sonnet` in `agents/impact-analyst.md`. The analysis is mechanical (run the deterministic CLI, read a handful of call sites, format ~15 lines), so a cheap model is the right default and it keeps the cost independent of the session model.

The user overrides it at prompt time. When they explicitly ask for a model — "use haiku for the impact analysis", "run the analysis on opus", "cheapest model for this" — pass that model as the Task tool's `model` parameter when you launch `impact-analyst`. The prompt request wins; the `sonnet` default applies only when the user says nothing. Note the underlying analysis (`lib/analyze.js`) is deterministic Node with no LLM — the model choice only affects the thin subagent that runs the CLI and summarizes, never the numbers.

## When to trigger

**Before writing**, as soon as the task touches existing code. Not after: a report read after the fact only serves to observe the damage.

**Before opening the PR**, on the full diff — the real scope often differs from the planned scope.

**On an estimate request.** An estimate based on the ticket's wording and an estimate based on the actual structure differ by an order of magnitude. This is the most cost-effective and least obvious use case.

## What to do with the verdict

| Risk | Action |
|---|---|
| **LOW** | implement; mention the scope in one line, without ceremony |
| **MODERATE** | announce the scope and the tests you are going to run, then implement |
| **HIGH** | lay out the scope, quantify two options, let the user decide before writing |
| **BLOCKING** | don't write; summarize why and ask for explicit validation |

On HIGH, the typical choice is: refactor all the callers, or add an overload with documented debt. It is a budget choice, not a technical choice — don't decide it in their place.

On BLOCKING, there is deliberately no `--force`. The workaround must be a conscious human decision, not a flag.

If the analysis surfaces **consumer repos** or **declared external consumers**, say it before anything else. This is the information the developer has no other way of obtaining.

## Honesty about confidence

The report labels each section: textual (name-based search, possible homonyms), historical (deterministic on git), structural (patterns). Reuse these labels when you talk to the user.

Say "the report identifies 47 sites", never "there are 47 sites". This is not rhetorical caution: the blind spots are real — reflection, convention-based DI, hardcoded SQL, jobs configured in the database, view bindings. A scope presented as exhaustive is more dangerous than no scope, because it grants permission to stop thinking.

And the analysis never replaces compiling then testing. It reduces ignorance upfront; it proves nothing.

## When the guardrail blocks you

The `PreToolUse` hook refuses a modification when no fresh report covers the targeted file. This is not a refusal from the user: it is an automatic control. Run the analysis, summarize, then retry the same modification without asking permission again — unless the risk is BLOCKING, in which case you must indeed ask.

## Calibration

Each repo can have an `impact.config.json`: thresholds, external consumers, ignored paths, test conventions. If a report visibly produces noise — an overly generic symbol, callers that are massively false positives — propose adjusting the config rather than ignoring the report.

A guardrail that screams on every ticket is disabled within two weeks. That is the only failure mode that really matters.
