# 08 — Configuration Reference

> **Abstract.** This document is the complete, authoritative reference for how
> `seismo-cc` (a.k.a. claude-impact) is configured. Every field, its type, its
> **real** default (read directly from [`lib/config.js`](../lib/config.js), not
> guessed), its meaning, and its concrete effect on the analysis and the risk
> gate are documented here. It also covers how the config file is discovered and
> merged, the `ignore` matching semantics, calibration guidance, the escalation
> effects of `externalConsumers` and `memoryPath`, and the environment variables
> actually read by the code.
>
> Ground truth: [`lib/config.js`](../lib/config.js),
> [`impact.config.example.json`](../impact.config.example.json),
> [`lib/scan.js`](../lib/scan.js), [`lib/rules.js`](../lib/rules.js),
> [`lib/analyze.js`](../lib/analyze.js), [`bin/impact.js`](../bin/impact.js),
> [`hooks/incident-record.js`](../hooks/incident-record.js).

## Table of contents

1. [How configuration is loaded](#1-how-configuration-is-loaded)
2. [Full field reference](#2-full-field-reference)
3. [Threshold semantics (effect on risk)](#3-threshold-semantics-effect-on-risk)
4. [`ignore` matching semantics](#4-ignore-matching-semantics)
5. [Calibration guidance](#5-calibration-guidance)
6. [`externalConsumers` and `memoryPath`: what enabling them changes](#6-externalconsumers-and-memorypath-what-enabling-them-changes)
7. [Environment variables](#7-environment-variables)
8. [A realistic sample `impact.config.json`](#8-a-realistic-sample-impactconfigjson)

Related reading: [05-analysis-pipeline.md](05-analysis-pipeline.md) (where the
config feeds the scan and coupling stages), [06-risk-model.md](06-risk-model.md)
(how thresholds map to risk levels), and
[09-limitations-and-validity.md](09-limitations-and-validity.md) (why the
defaults are only a starting point).

---

## 1. How configuration is loaded

Configuration is **entirely optional**. With no config file at all, the tool
runs on the built-in `DEFAULTS` and produces a valid report — the
`impact.config.example.json` header even says so: *"Everything is optional."*

### File name and location

The loader looks for exactly one file: **`impact.config.json`** at the **repo
root** ([`lib/config.js:68`](../lib/config.js)):

```js
function load(root) {
  const p = path.join(root, 'impact.config.json');
  ...
}
```

"Repo root" is whatever directory `root` resolves to for the current invocation
(see [root/workspace overrides](#rootworkspace-overrides) below). There is no
search up the directory tree and no support for a home-directory or global
config — it is strictly `<root>/impact.config.json`.

### The `configFound` flag

`load()` always returns a config object, whether or not a file was present. It
records **whether** a file existed via `cfg.configFound`
([`lib/config.js:82`](../lib/config.js)):

```js
cfg.configFound = fs.existsSync(p);
```

Downstream code (report rendering, and [09](09-limitations-and-validity.md))
uses this flag to tell the reader whether they are looking at defaults or at
calibrated thresholds. `configFound: false` is a signal that **the thresholds
have not been measured for this repo** and should be treated with caution.

### A broken config is loud, never silent

If `impact.config.json` exists but is not valid JSON, `load()` **throws** rather
than falling back to defaults ([`lib/config.js:70-76`](../lib/config.js)):

```js
try {
  user = JSON.parse(fs.readFileSync(p, 'utf8'));
} catch (e) {
  throw new Error(`impact.config.json unreadable: ${e.message}`);
}
```

This is deliberate: a typo in the config must fail the run, not silently revert
to unmeasured defaults.

### Merge behavior

The merge is a **shallow spread with two special cases**
([`lib/config.js:78-81`](../lib/config.js)):

```js
const cfg = { ...DEFAULTS, ...user };
cfg.thresholds = { ...DEFAULTS.thresholds, ...(user.thresholds || {}) };
cfg.ignore = user.ignore ? DEFAULTS.ignore.concat(user.ignore) : DEFAULTS.ignore;
```

| Field | Merge rule | Consequence |
|-------|-----------|-------------|
| `thresholds` | **Deep-merged** per key | You may override only `callersHigh` and keep every other default threshold. |
| `ignore` | **Concatenated** (defaults + yours) | You can only **add** ignore patterns; the built-in list can never be removed by config. |
| Everything else (`extensions`, `testPatterns`, `externalConsumers`, `workspace`, `gitDepth`, `memoryPath`) | **Replaced wholesale** by a top-level spread | If you set `extensions` or `testPatterns`, your array **replaces** the default array entirely — it is not merged. Provide the complete list. |

> **Pitfall.** Because `extensions` and `testPatterns` are replaced (not merged),
> setting `"extensions": [".cs"]` will make the tool stop analyzing `.ts`,
> `.php`, etc. If you only want to *add* a language, copy the full default array
> and append. `ignore` is the sole additive array.

### root/workspace overrides

The active `root` is resolved before `load()` is called:

- **CLI**: `engine.run()` uses `path.resolve(opts.root || process.cwd())`
  ([`lib/analyze.js:133`](../lib/analyze.js)); `opts.root` comes from the
  `--root` flag. The `gate` command does the same
  ([`bin/impact.js:81`](../bin/impact.js)). With no `--root`, the current working
  directory is the root.
- **`--workspace`**: after loading, `run()` overrides the loaded `workspace`
  with the flag if present ([`lib/analyze.js:135`](../lib/analyze.js)):
  ```js
  if (opts.workspace) cfg.workspace = opts.workspace;
  ```
  So `--workspace` on the command line beats whatever `workspace` the config
  file declared. See [06](06-risk-model.md) and
  [`externalConsumers`/cross-repo](#6-externalconsumers-and-memorypath-what-enabling-them-changes).

> **Note on sibling repos.** During a cross-repo scan, each sibling repo is
> loaded with its **own** `impact.config.json` via `config.load(repoRoot)`
> ([`lib/analyze.js:58`](../lib/analyze.js)). Config is per-repo, not shared
> across the workspace.

---

## 2. Full field reference

All defaults below are read verbatim from
[`lib/config.js:5-38`](../lib/config.js). This is the ground truth — the numbers
are copied, not remembered.

| Field | Type | Default | Meaning | Effect on analysis / risk |
|-------|------|---------|---------|---------------------------|
| `ignore` | `string[]` | `["node_modules", ".git", ".impact", "bin", "obj", "dist", "build", "out", "vendor", "packages", ".next", ".nuxt", "coverage", "wwwroot/lib", "*.min.js", "*.designer.cs", "*.g.cs", "*.generated.cs", "*.lock"]` | Files/dirs excluded from the scan. Deliberately broad. | Excluded paths are never walked and never counted as call sites. Your entries are **appended** to the defaults ([`lib/config.js:80`](../lib/config.js)). See [§4](#4-ignore-matching-semantics). |
| `extensions` | `string[]` | `[".cs", ".php", ".kt", ".kts", ".ts", ".tsx", ".js", ".jsx", ".vue", ".razor", ".cshtml", ".blade.php", ".sql"]` | File extensions treated as analyzable source. | A file must end with one of these to be scanned ([`lib/scan.js:46`](../lib/scan.js)). Setting this **replaces** the list. |
| `testPatterns` | `string[]` | `["Tests/", "Test/", "tests/", ".Tests.", "Test.cs", "Tests.cs", "Test.php", "Spec.php", ".spec.", ".test."]` | Substrings that mark a file as a test. | A file whose relative path **contains** any pattern is classified as a test ([`lib/scan.js:430-432`](../lib/scan.js)). Used to compute "affected tests" and to weight risk (test-only impact is lower). Setting this **replaces** the list. |
| `gitDepth` | `number` | `400` | Number of recent commits of git history analyzed for co-change coupling. | Controls how far back `git log` looks when computing coupling. Larger = more history, slower; smaller = noisier ratios. Feeds the coupling stage in [05](05-analysis-pipeline.md). |
| `thresholds` | `object` | see below | Gate thresholds. **Deep-merged.** | Drives the risk level. See [§3](#3-threshold-semantics-effect-on-risk). |
| `thresholds.callersWarn` | `number` | `15` | Warn level for number of call sites. | `callers >= callersWarn` lifts a `low` risk to `moderate` ([`lib/rules.js:132-134`](../lib/rules.js)). |
| `thresholds.callersHigh` | `number` | `40` | High level for number of call sites. | `callers >= callersHigh` lifts risk to `high` (unless already `blocking`) ([`lib/rules.js:129-131`](../lib/rules.js)). |
| `thresholds.couplingMinCommits` | `number` | `3` | Minimum co-change commits before a coupling pair is reported. | Pairs seen together in fewer than this many commits are dropped as statistical noise ([`lib/analyze.js:217`](../lib/analyze.js)). |
| `thresholds.couplingMinRatio` | `number` | `0.4` | Minimum co-change ratio (0–1). | A file must co-change in `>= 40%` of the commits that touch the target to be reported as coupled ([`lib/analyze.js:218`](../lib/analyze.js), [`lib/config.js:25`](../lib/config.js)). |
| `thresholds.reportMaxAgeMinutes` | `number` | `120` | Maximum age of a report the gate will accept. | The PreToolUse gate blocks if `.impact/latest.json` is older than this ([`bin/impact.js:104-106`](../bin/impact.js)). Forces re-analysis of stale reports. |
| `externalConsumers` | `array` | `[]` | Hand-declared consumers outside this repo (name/consumes/contact objects, or strings). | The graph never guesses these. A non-empty list **combined with** modified public surface escalates risk to `blocking` ([`lib/rules.js:147-149`](../lib/rules.js)). See [§6](#6-externalconsumers-and-memorypath-what-enabling-them-changes). |
| `workspace` | `string \| null` | `null` | Parent directory of sibling repos, for the optional cross-repo scan. `~` is expanded to `$HOME`. | When set, `run()` scans sibling git repos for references to the modified symbols ([`lib/analyze.js:44-66,238`](../lib/analyze.js)). Any cross-repo hit escalates risk to at least `high` ([`lib/rules.js:142-144`](../lib/rules.js)). Overridable with `--workspace`. |
| `memoryPath` | `string \| null` | `null` | Path to a seismo-memory store (JSON) of past incidents. `null` = disabled. | **Purely advisory.** Enables `priorHints` annotations on symbols/files, but **never** changes `risk.level` or the gate decision ([`lib/config.js:33-37`](../lib/config.js), [`lib/analyze.js:252`](../lib/analyze.js)). See [§6](#6-externalconsumers-and-memorypath-what-enabling-them-changes). |
| `root` | `string` | (injected) | The resolved repo root. | Set by `load()` at runtime ([`lib/config.js:81`](../lib/config.js)); not a user field. |
| `configFound` | `boolean` | (injected) | Whether a config file was present. | Set by `load()` ([`lib/config.js:82`](../lib/config.js)); not a user field. Reported to signal "defaults vs calibrated". |

> **`IRREVERSIBLE` and `API_SURFACE` are not user-configurable.** The two
> constant arrays in [`lib/config.js:42-65`](../lib/config.js) — the regex
> signatures of irreversible operations (EF/Laravel migrations, destructive SQL,
> bulk deletes, mail, jobs, payments, outbound calls, filesystem writes, auth
> changes) and of public API surface (ASP.NET/FastEndpoints/minimal-API/Laravel
> routes, SignalR hubs, DTO/Request/Response contracts) — are **code
> constants**, not config fields. They carry the weights that drive `blocking`
> risk (`weight >= 5` = `blocking`, `>= 3` = `high`;
> [`lib/rules.js:125-127`](../lib/rules.js)). To change detection you edit the
> source, not the JSON. They are documented in [06-risk-model.md](06-risk-model.md).

---

## 3. Threshold semantics (effect on risk)

The full mapping lives in [`lib/rules.js:120-154`](../lib/rules.js) and is
detailed in [06-risk-model.md](06-risk-model.md). In terms of the config
thresholds:

| Signal | Threshold field | Resulting level |
|--------|-----------------|-----------------|
| Irreversible op, worst `weight >= 5` | (constant, not config) | `blocking` |
| Irreversible op, worst `weight >= 3` | (constant, not config) | `high` |
| `callers >= callersHigh` | `callersHigh` (40) | `high` (if not already `blocking`) |
| `callersWarn <= callers < callersHigh` | `callersWarn` (15) | `moderate` (if currently `low`) |
| Any public API surface touched | (constant detection) | at least `moderate` |
| Any cross-repo consumer hit | `workspace` enabled | at least `high` |
| Declared external consumer **and** public surface touched | `externalConsumers` + surface | `blocking` |

Coupling thresholds (`couplingMinCommits`, `couplingMinRatio`) do **not**
directly set a risk level; they filter which co-changed files are *reported* as
coupling signals ([`lib/analyze.js:217-218`](../lib/analyze.js)). They shape the
report's coupling section and the reviewer's attention, not the numeric gate.

---

## 4. `ignore` matching semantics

The `ignored()` function ([`lib/scan.js:10-26`](../lib/scan.js)) matches a
pattern against a relative path in **three distinct modes**, chosen by the shape
of the pattern. Crucially, a plain word matches a **whole path segment**, never
a raw substring — this is a deliberate fix (see the comment at
[`lib/scan.js:5-9`](../lib/scan.js)) because the old substring version silently
excluded legitimate files like `routes/web.php` (contains `out`),
`Distance.cs` (contains `dist`), and `query_builder.php` (contains `build`).

| Pattern shape | Mode | Rule | Example |
|---------------|------|------|---------|
| Starts with `*` | **Suffix glob** | `name.endsWith(pat.slice(1))` — matches on the **file name** | `*.min.js`, `*.designer.cs`, `*.lock` |
| Contains `/` | **Multi-segment, boundary-anchored** | trailing `/` stripped, then `` `/${rel}/`.includes(`/${p}/`) `` | `wwwroot/lib`, `Migrations/Snapshots/` |
| Plain word (no `*`, no `/`) | **Whole-segment** | `rel.split('/').includes(pat)` — the pattern must equal an entire path segment | `node_modules`, `bin`, `obj`, `dist` |

Notes:

- A trailing slash on a multi-segment pattern is optional and stripped
  (`Legacy/` ≡ `Legacy`) before matching ([`lib/scan.js:18`](../lib/scan.js)).
- Paths from `git` (the `--diff` path) don't go through `walk()`, so they are
  re-filtered by `filterPaths()` with the same `ignored()` plus a hard-coded
  `.impact/` exclusion ([`lib/scan.js:439-446`](../lib/scan.js)).

This is the same matching model referenced in
[04](04-scan-and-resolution.md) (scan and resolution). Cross-reference there for
how the walked file set is then resolved into declarations and call sites.

---

## 5. Calibration guidance

**The defaults are a starting point, not a recommendation.** The code says so
in three places: [`lib/config.js:19-20`](../lib/config.js) ("Tune them AFTER
measuring on your repos: a gate that screams on every ticket is ignored within
two weeks"), the example header ([`impact.config.example.json:12`](../impact.config.example.json)):
*"A 293-entity monolith does not share the same thresholds as a
microservice."*

### The real product risk is the noise threshold

The failure mode is not "the gate missed something." It is **the gate cries
`BLOCKING` so often that engineers learn to ignore it**. A blocking gate that
fires on every second ticket is, within two weeks, worth exactly nothing. So
calibration is not cosmetic — it is what keeps the tool credible. See
[09-limitations-and-validity.md](09-limitations-and-validity.md) for the
validity argument.

### How to measure per repo

- **Measure, don't guess `callersWarn`/`callersHigh`.** Run the analysis across
  a representative set of recent changes and look at the *distribution* of call
  sites. A 300-entity .NET monolith has hub types with hundreds of callers where
  40 is unremarkable; a microservice where 40 callers is alarming needs much
  lower thresholds. Set `callersHigh` so that only genuinely wide-blast changes
  trip it.
- **Tune coupling to your commit hygiene.** `couplingMinCommits` (default 3)
  should rise on repos with many tiny commits and fall on repos with few, large
  commits. `couplingMinRatio` (default 0.4) controls how tightly two files must
  move together before you're told about it.
- **Set `gitDepth` to a window that reflects current architecture.** Default 400
  commits; shorten it on a fast-moving repo so ancient, since-refactored
  coupling doesn't dominate; lengthen it on a slow repo to get enough signal.
- **Set `reportMaxAgeMinutes` to your review rhythm.** 120 min is generous;
  tighten it if changes land fast and you want the gate to force a fresher
  analysis.

A monolith and a microservice living in the same organization should have
**different** `impact.config.json` files. There is no single correct value.

---

## 6. `externalConsumers` and `memoryPath`: what enabling them changes

These two fields are the ones whose *presence* changes behavior, in opposite
ways: one escalates the gate, the other never does.

### `externalConsumers` — escalation to `blocking`

Entries can be strings or objects with `name` / `consumes` / `contact`
([`impact.config.example.json:14-17`](../impact.config.example.json)):

```json
"externalConsumers": [
  { "name": "Internal mobile app (KMP)", "consumes": "/api/checkout", "contact": "mobile-team@example.com" },
  { "name": "Partner portal", "consumes": "SignalR /hubs/orders", "contact": "alerts@example.com" }
]
```

Effect: the count is passed into the risk summary as
`externalConsumers: (cfg.externalConsumers || []).length`
([`lib/analyze.js:244`](../lib/analyze.js)), and the rule
([`lib/rules.js:147-149`](../lib/rules.js)):

```js
if (summary.externalConsumers > 0 && summary.apiSurface > 0) {
  level = 'blocking';
  reasons.push('declared external consumer + public surface modified');
}
```

So declaring external consumers is a way of saying: *"if this change touches the
public surface, treat it as `blocking`, because someone outside this repo
depends on it."* The consumers are also rendered in the report with their
contact info ([`lib/report.js:70-73`](../lib/report.js)) so the reviewer knows
whom to warn. Declaring consumers alone (with no surface change) does not by
itself block.

> Related but separate: the `workspace` cross-repo scan *discovers* consumer
> repos and escalates to at least `high` ([`lib/rules.js:142-144`](../lib/rules.js)).
> `externalConsumers` is the hand-declared complement for consumers the scan
> cannot see (mobile apps, partners, other orgs).

### `memoryPath` — advisory `priorHints`, never blocking

Setting `memoryPath` (relative path anchored on the repo root, e.g.
`.impact/memory.json`, or an absolute/central path to share incidents across
repos) enables the seismo-memory store. When enabled, past incidents are loaded
and matched against the current symbols/files to produce **`priorHints`**
([`lib/analyze.js:252`](../lib/analyze.js)):

```js
const priorHints = memory.priorHints(memory.load(cfg, root), symbols, targetFiles);
```

These hints are rendered in the report ([`lib/report.js:156-161,197`](../lib/report.js))
as *"Prior incidents (advisory)"*. The contract, stated explicitly in
[`lib/config.js:33-37`](../lib/config.js) and reinforced in the example
([`impact.config.example.json:27`](../impact.config.example.json)), is:

> **ADVISORY ONLY: prior incidents annotate symbols but never change the risk
> level or the gate decision.**

The store format is a JSON document:

```json
{ "incidents": [
  { "symbol": "Checkout", "file": "src/Order.cs", "kind": "regression", "ref": "TICKET-123", "at": "2026-03-01" }
] }
```

Incidents are appended by the `incident-record.js` hook (see [§7](#7-environment-variables)).
The loop is: a revert/incident is recorded → next analysis surfaces it as a
`priorHint` → the reviewer sees "this symbol has burned us before" — **without**
the deterministic gate ever being influenced. This keeps the gate reproducible
while still carrying institutional memory.

---

## 7. Environment variables

These are the environment variables actually read by the code (grep-verified),
with the file and line where each is consumed:

| Variable | Read in | Default when unset | Effect |
|----------|---------|--------------------|--------|
| `CLAUDE_PLUGIN_ROOT` | [`bin/impact.js:88`](../bin/impact.js), [`.claude-plugin/plugin.json:13`](../.claude-plugin/plugin.json), [`hooks/hooks.json:9`](../hooks/hooks.json) | `path.resolve(__dirname, '..')` (the plugin dir) | Absolute path to the installed plugin. Used to build **copy-pasteable** `node "…/bin/impact.js"` commands in gate messages and to locate the MCP server and hook scripts. Set by the Claude Code plugin host. |
| `SEISMO_ROOT` | [`hooks/incident-record.js:23`](../hooks/incident-record.js) | `process.cwd()` | Repo root the incident-record hook operates on when recording a revert/incident into the memory store. |
| `SEISMO_REVERT_DEPTH` | [`hooks/incident-record.js:26`](../hooks/incident-record.js) | `200` (used only when the env value is a number `> 0`) | How many recent commits the incident hook scans to detect reverts. |
| `HOME` | [`lib/analyze.js:45`](../lib/analyze.js), [`test/calibrate.js:36`](../test/calibrate.js) | literal `~` (no expansion) | Expands a leading `~` in `workspace` (and in the calibration harness target) to the user's home directory. |

Notes on the incident hook: it is a **silent no-op** when `memoryPath` is unset
or the target is not a git repo, and it **never blocks** a merge or pipeline
(always exits 0) — per the README (`README.md:337-340`). It only *writes*
incidents; the analysis later *reads* them as advisory `priorHints` (see
[§6](#6-externalconsumers-and-memorypath-what-enabling-them-changes)).

---

## 8. A realistic sample `impact.config.json`

A calibrated config for a mid-size .NET monolith with a hand-declared mobile
consumer and shared incident memory. Note that `extensions`/`testPatterns` are
given in full (they replace, not merge) and that `ignore` only lists **extra**
patterns (they are appended to the defaults):

```json
{
  "thresholds": {
    "callersWarn": 25,
    "callersHigh": 80,
    "couplingMinCommits": 4,
    "couplingMinRatio": 0.45,
    "reportMaxAgeMinutes": 90
  },

  "externalConsumers": [
    { "name": "Mobile app (KMP)", "consumes": "/api/checkout", "contact": "mobile-team@example.com" }
  ],

  "ignore": ["Legacy/", "*.Designer.cs", "Migrations/Snapshots/"],

  "testPatterns": ["Tests/", ".Tests.", "Test.cs", "IntegrationTests/"],

  "gitDepth": 600,

  "memoryPath": ".impact/memory.json"
}
```

Why these values (for **this hypothetical repo** — measure your own):

- `callersHigh: 80` because hub services in this monolith routinely have 40–60
  callers; the default 40 would fire `high` on ordinary changes and become
  noise.
- `couplingMinCommits: 4` / `couplingMinRatio: 0.45` slightly stricter than
  default to cut coupling chatter on a busy repo.
- `gitDepth: 600` to capture a longer architectural window on a slow-moving
  monolith.
- `reportMaxAgeMinutes: 90` to force a fresher analysis given a fast review
  cadence.
- `externalConsumers` declared so any change to `/api/checkout`'s public surface
  escalates to `blocking`.
- `memoryPath` enabled for advisory `priorHints` only — it will never change the
  gate outcome.

---

*See also:* [05-analysis-pipeline.md](05-analysis-pipeline.md) ·
[06-risk-model.md](06-risk-model.md) ·
[09-limitations-and-validity.md](09-limitations-and-validity.md)
