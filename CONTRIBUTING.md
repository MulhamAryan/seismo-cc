# Contributing to seismo-cc

Thanks for considering a contribution. A few ground rules keep this tool useful.

## The zero-dependency rule

The engine must run on **Node 18+ with no `npm install`**. It has to drop into any
repo without a build, a package manager step, or a service to host. Any
contribution that adds a runtime dependency will be declined. Dev-only tooling in
`test/` may use Node built-ins only, same constraint.

## Before opening a PR

```bash
./test/smoke.sh
```

Expected: `81 passed, 0 failed` on Linux/macOS/WSL. (On Windows/Git Bash a few
assertions fail on path resolution — see `test/README.md`. CI runs on Linux.)

If you change behavior, add or update an assertion in `test/smoke.sh` (or a unit
in `test/unit.js`) that would fail without your change. New user-facing strings
are English.

## What makes a good change

- **Fewer false positives before more features.** The tool dies the day it cries
  wolf on every ticket. A change that reduces noise is worth more than one that
  adds a detector.
- **Honesty over completeness.** If the analysis cannot see something, the report
  says so. Do not present a heuristic as a proof.
- **.NET is the first-class stack.** Improvements to C# resolution are the highest
  leverage. Other stacks are best-effort; git coupling is language-agnostic.

## Calibrate before claiming a threshold change

If you touch `lib/config.js` risk rules or thresholds, run
`node test/calibrate.js ~/repos --commits 60` on real repos and include the
before/after distribution in the PR. Thresholds are meant to be tuned per repo in
`impact.config.json`, not hardcoded globally.

## Scope of the guard

The `PreToolUse` guard is deliberately conservative: it blocks on a missing/stale
report, an out-of-scope file, a content-hash mismatch, or a `blocking` risk. It
does **not** block `high` risk. There is intentionally no `--force`. Keep it that
way unless you have calibration data arguing otherwise.
