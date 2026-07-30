---
name: Bug report
about: A wrong result, a crash, or the gate misbehaving
title: "[bug] "
labels: bug
---

## What happened

<!-- A clear description of the bug. -->

## What you expected

<!-- What the report / gate should have said instead. -->

## How to reproduce

- Command used (e.g. `node bin/impact.js analyze --symbols … --short`, or `/seismo-cc:impact …`):
- Mode: `plan` / `diff`
- Relevant `impact.config.json` settings (or "defaults"):

## Environment

- Stack of the analyzed repo: **.NET / PHP-Laravel / Kotlin / TypeScript / other**
- Node version (`node --version`):
- OS:
- seismo-cc version / commit:

## Output

<!--
Paste the relevant part of `.impact/report.md` or the `--json` output.
Redact anything private. If it is a false positive / noise problem, say how
often it fires — the noise rate is the metric that matters most.
-->

## Anything else

<!-- Is this a false positive, a false negative, a crash, a gate decision you disagree with? -->
