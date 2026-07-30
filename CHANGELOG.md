# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] — 2026-07-30

### Fixed
- **Over-estimation on greenfield specs.** `brief`, `scope` and the analyst
  conflated three orthogonal axes under one word ("HIGH"), so a not-yet-built
  feature read as "hard to code". They now keep them separate: **blast-radius
  risk** (how far a change to existing code ripples — ~nil for greenfield),
  **build complexity** (net-new *subsystems* only), and **effort** (time, only
  if asked). A dependency on another system or an unmade decision is now framed
  as a coordination/decision matter, not coding difficulty.
- **Net-new counted at equal weight.** A concept with no local symbol but a
  same-kind sibling to copy (a new endpoint next to an existing one) is now
  classified as cheap **wiring**, not a net-new subsystem. Complexity counts
  net-new *subsystems* only, so a ten-line copy no longer inflates the size.
- **False "everything is net-new / BLOCKING" across repos.** `brief`/`scope`/the
  analyst now scan sibling repos with `--workspace` when the spec names another
  system, before concluding anything is missing: a concept that resolves in a
  sibling is **cross-repo reuse**, not net-new. The analyst no longer returns
  BLOCKING because a symbol is absent from *this* repo when the spec points at
  another one.
- **Unbounded time estimates.** When a number is asked for, it must now state a
  fixed boundary — `git checkout → git push` by a developer who knows the repo,
  excluding deployment, production migration, acceptance and cross-team
  coordination — instead of silently mixing those in.

## [0.2.0] — 2026-07-30

### Fixed
- **Path-segment exclusion.** `ignored()` matched patterns as raw substrings, so
  legitimate paths were silently dropped from the scan (`routes/web.php` contains
  "out", `Distance.cs` contains "dist", `query_builder.php` contains "build") —
  including the public surface the tool claims to detect. Now matches on path
  segment boundaries.
- **Guard could be satisfied trivially.** Coverage no longer holds just because a
  file name appears in a fresh report. Each analysis records a SHA-1 content hash
  per in-scope file (`fileHashes`); the guard recomputes and refuses if the file
  changed since the analysis, so a stale-content report no longer lets an edit
  through.
- **`--json` output polluted.** The status line now goes to stderr in `--json`
  mode, leaving stdout as pure, parsable JSON.
- **Silent reference cap.** `references()` no longer caps the call-site count at 50
  without saying so; the displayed line list is bounded but the count is
  uncapped, and truncation plus total occurrences are surfaced.
- **Merge double-counting.** `git log -m` emits a merge commit once per parent;
  `parseLog` now deduplicates by SHA so historical-coupling counts are not
  inflated on merge-heavy histories.

### Added
- **Indirect (2-hop) impact (P3).** `lib/transitive.js` computes exactly one
  extra hop — the direct callers → the types they declare → the files that
  reference those types — surfacing second-order scope that a change can ripple
  to without ever naming the changed symbol. Rendered as an "Indirect impact
  (2 hops)" section (`confidence: indirect`) and `indirect[]` in `latest.json`.
  Report-only: never affects the risk or the gate. Bounded and toggleable via the
  `indirect` config flag (default on). Not full transitive closure (needs a
  resolved graph, out of scope).
- **Empirical validation harness (P2).** `lib/validate.js` measures the
  transaction-based precision/recall of the co-change predictor using the MSR
  leave-out method: each commit is a transaction, one file is the query seed, the
  rest is predicted from prior history only (temporal, leakage-free) and scored
  against what actually co-changed. Sweeps `couplingMinCommits` × `couplingMinRatio`
  so thresholds can be tuned per repo. Pure `git.couplingFrom` extracted from
  `git.coupling`; CLI runner `node test/validate.js <repo> [--window N] [--json]`.
  Scoped honestly: validates the coupling signal only (static fan-in needs a
  resolved oracle, out of scope); recall is a conservative lower bound.
- **Hidden-dependency checks (P1).** Advisory lexical scans that shrink the
  blind-spot list by reporting what the reference search cannot see: the symbol
  name inside string literals (reflection / DI / serialization / config), an
  entity's table name in SQL (hardcoded SQL), reflection / convention-DI
  constructs, and routes built by concatenation. Computed after the risk verdict
  and never fed back — the gate stays deterministic. New report section
  "Hidden-dependency checks" and `hiddenChecks[]` in `latest.json`
  (`lib/hidden.js`). See `docs/ROADMAP.md`.
- **MCP transport (`seismo-impact`).** A zero-dependency stdio JSON-RPC 2.0 server
  over the same engine, exposing four tools: `get_blast_radius` (the only one that
  persists `.impact/latest.json` and feeds the gate), `get_affected_tests`,
  `get_public_api_diff`, `get_irreversible_ops` (advisory queries that never
  overwrite coverage). Declared in `.claude-plugin/plugin.json`.
- **One-line marketplace install.** Ship `.claude-plugin/marketplace.json` at the
  repo root so it installs directly: `/plugin marketplace add MulhamAryan/seismo-cc`
  then `/plugin install seismo-cc@seismo-cc`.
- **Four extra slash commands.** `/seismo-cc:tests` (affected tests only, structural
  + historical), `/seismo-cc:api-diff` (breaking public-surface changes vs a base),
  `/seismo-cc:brief` (a plain-language business brief for analysts / PMs / leads),
  and `/seismo-cc:scope` (scope a not-yet-built feature from a spec — map each
  concept to a reusable anchor found in the code or a net-new piece to build).
  All delegate to the read-only `impact-analyst` subagent, alongside
  `/seismo-cc:impact` (full scope). No new computation — audience/planning views
  over the existing `latest.json`.
- **Reframed sizing for agent-written code.** `brief` and `scope` no longer imply
  developer-hours (S/M/L/XL person-days): since the code may be written by an
  agent, they size work by **reuse-vs-net-new building blocks** plus a labelled
  complexity estimate, separate **measured** (from `latest.json`) from
  **estimated** (agent judgment), and surface **the decisions a human must make**.
  On a greenfield spec (empty diff) they say the work is mostly net-new instead of
  reporting a misleading "small".
- **`INSTALL.md`** covering every method: Claude Code marketplace, local plugin dir,
  entry in another catalog, standalone CLI, MCP server, per-repo configuration.
- **In-depth `docs/`.** Ten grounded documents (architecture, scientific concepts,
  formal mathematical model with equations, algorithms and complexity, analysis
  pipeline, risk model, git historical coupling, configuration reference,
  limitations and validity) plus an index; every claim cites `file:line`.
- **.NET-focused resolution.** Ambiguous symbols (multiple declarations across
  namespaces) are detected and flagged instead of silently merged; namespace-aware
  `namespaceAt`; `stripNoise` handles C# verbatim (`@"…"`) and interpolated
  (`$"…{expr}…"`) strings and TypeScript template literals, keeping interpolation
  expressions while dropping literal text; C# declaration regexes now catch
  `private` methods, expression-bodied members and attributed methods.
- **Qualified-reference confidence for non-.NET stacks.** For PHP/Kotlin/TypeScript
  the reference search builds a small import graph and tags each caller `high` /
  `normal` / `low` (exact import path, same module, or qualified call site vs. a
  same-named symbol imported from another module). Additive — raw counts feeding
  the risk score are unchanged.
- **Public API before/after diff (`apiBreaking`).** In diff mode with a base, the
  engine diffs the public surface against the merge base and reports only breaking
  changes (`removed` / `changed`); additions are excluded by contract.
- **Advisory prior-incident memory (`priorHints`).** Optional, off by default
  (`memoryPath`). Annotates symbols/files with past incidents; computed after risk
  and never fed back, so the gate stays deterministic. Fed via
  `impact record --file … --ref …` or `--from-reverts` (git `post-merge` hook),
  idempotent, degrades gracefully when unset.
- **Cross-repo sibling scan.** Optional `--workspace` name search across sibling
  repos surfaces consumer repos the in-repo graph cannot see.
- **Configurable analyst model.** `agents/impact-analyst.md` declares `model: sonnet`
  as the default (mechanical read-and-format work); the user can override it per
  prompt (e.g. "use haiku"), honored via the Task model override.
- English throughout (report output, risk labels, CLI, hook messages, tests, shell
  scripts, docs).

### Changed
- Risk-level values are now `low` / `moderate` / `high` / `blocking`.
- README documents per-stack support with .NET as the first-class target;
  PHP/Laravel, Kotlin and TypeScript are best-effort; git coupling is
  language-agnostic.
- Anonymized all examples to a neutral sample domain (`Checkout`/`Order`,
  `sample-service`); test fixture and smoke suite renamed to match.
- `test/smoke.sh` made portable on Windows/git-bash (POSIX paths converted for
  node inside `-e` literals and JSON payloads); the full suite passes locally,
  unchanged on Linux CI.

## [0.1.0]
- Initial engine (zero-dependency Node CLI), analyst subagent, impact-analysis
  skill, `/seismo-cc:impact` command, and `PreToolUse` guard.
