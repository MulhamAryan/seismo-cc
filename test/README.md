# Testing seismo-cc

Four phases, in this order. The first three take about ten minutes; the fourth is the one that decides whether the tool is deployable.

## Phase 1 — Engine and guard (automated)

```bash
./test/smoke.sh
```

Builds a synthetic repo (.NET + Laravel + Kotlin, with git history), then checks 81 assertions: symbol resolution, historical coupling, detection of concatenated raw SQL, escalation to BLOCKING on a destructive migration, cross-repo signal, the three guard paths, the hook's output contract, graceful degradation outside a git repo, path-segment exclusion, content-hash freshness, clean `--json` output, non-silent truncation, merge SHA dedup, and .NET declaration/`stripNoise`/namespace units — plus validity of every plugin component.

Expected: `81 passed, 0 failed`.

> On Windows/Git Bash a few assertions fail on path resolution (`node` cannot resolve MSYS `/…` paths passed to `require`/`readFileSync`, and the hook subprocess). The harness is written for Linux/macOS/WSL; CI runs it on Linux, where all assertions pass.

The fixture alone, if you want to poke around by hand:

```bash
./test/fixture.sh /tmp/fixture
cd /tmp/fixture/sample-service
node <plugin>/bin/impact.js analyze --symbols Checkout
cat .impact/report.md
```

The interesting case to observe: `CheckoutRepository.cs` shows up in the report. It never names `Checkout` in a signature — only historical coupling surfaces it. That is the mechanism that justifies the tool; if that assertion ever breaks, the tool is useless.

## Phase 2 — A real repo, read-only

Without installing the plugin, without the hook. Just the engine on a real project:

```bash
cd ~/repos/my-service
node <plugin>/bin/impact.js analyze --symbols <a-central-entity> --short
node <plugin>/bin/impact.js analyze --diff --base origin/main
```

Three questions to ask yourself while reading the report:

1. **Are the callers correct?** Take five entries at random, verify them by hand. If two out of five are homonyms, name-based search is not enough for this repo and you need the v2 Roslyn path.
2. **Does historical coupling teach you anything?** If the listed files are the ones you would have named off the top of your head, the tool adds nothing on this repo. If it surfaces one you had forgotten, it earns its place.
3. **Are the irreversible operations real?** This is the only section that tolerates no false positive: it is what triggers the block.

Then clean up: `rm -rf .impact`.

## Phase 3 — Loading in Claude Code (manual)

This is the one part not yet verified in this environment — the engine and hook are tested, the loading of components by Claude Code is not.

```bash
claude --plugin-dir /path/to/seismo-cc
```

Then, in the session:

| Command | Expected |
|---|---|
| `/plugin` | `seismo-cc` listed, Errors tab empty |
| `/agents` | `impact-analyst` present, read-only |
| `/seismo-cc:impact Checkout` | delegates to the subagent, returns a short report |
| `/context` | check the plugin's context cost |

Guard test, the most important one:

> ask Claude to modify a `.cs` file **without** having run an analysis

Expected: the hook blocks, Claude announces it is running the analysis, runs it, summarizes the scope, then retries the modification **without asking you for permission again**.

If Claude stops and waits instead of continuing, that is the known behavior where a hook block is read as a user refusal. The hook message is already worded to avoid it; if it persists, harden the wording in `hooks/impact-gate.js`.

Delegation test:

> ask for an ordinary refactoring task, without mentioning impact

Expected: the skill triggers on its own and delegates. If it does not trigger, that is a `description` problem in the frontmatter — make it more insistent and add the phrasings you actually use.

After any change to `hooks/`, `agents/` or `.claude-plugin/`: `/reload-plugins`. Only `SKILL.md` files are picked up hot.

## Phase 4 — Calibration (the deciding phase)

```bash
node test/calibrate.js ~/repos --commits 60
```

Replays the last 60 commits of each repo and measures which risk level the tool would have reported. Read-only, `.impact/` cleaned up at the end.

What you are looking for:

| Metric | Healthy range | If out of range |
|---|---|---|
| BLOCKING | 1–15% of commits | re-read the provided sample; if those commits were safe, lower the weight of overly broad patterns in `lib/config.js` |
| HIGH or above | < 40% | raise `callersWarn` and `callersHigh` |
| p50 latency | < 2000 ms | the hook becomes noticeable beyond that |

The script prints a sample of the commits that turned BLOCKING. **Re-read them one by one.** That is the only way to tell a real signal from an overly broad rule.

On the fixture, the script reports ~83% HIGH because the `auth` rule fires on `AllowAnonymous` on every commit touching the endpoint. That is a useful demonstration of the failure mode: a plausible rule, too high a weight, and the tool becomes unusable. Expect to find the equivalent on your own repos.

Thresholds are tuned **per repo** in `impact.config.json`. A 293-entity monolith and a microservice do not share the same profile, and a global threshold will be wrong for both.

## Deployment criterion

Do not push to the marketplace until, on at least three representative repos, you have:

- BLOCKING between 1 and 15%, and every sample case re-read and judged legitimate
- at least one file surfaced by historical coupling that you would not have named off the top of your head
- zero false positives in the "irreversible operations" section

If the third point does not hold, disable the hook and keep the tool in advisory mode only. A guard that blocks wrongly is worse than no guard: it teaches the team to route around it.
