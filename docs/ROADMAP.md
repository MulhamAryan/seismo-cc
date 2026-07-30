# seismo-cc — Roadmap

This roadmap is ordered by return on investment, not by ambition. The guiding
constraint is unchanged: the tool must **drop into any repo with no build**. So
the cheap, language-agnostic work comes first; the heavy, build- or
runtime-dependent work is explicitly optional and gated on real adoption.

Status legend: **planned** · **in progress** · **shipped**.

---

## P1 — Hidden-dependency checks (zero build) · effort S–M · **highest ROI** · shipped

The report's "Blind spots" section exists for honesty. P1 does not hide it — it
**shrinks** it, moving items from "blind" to "searched and reported", while
keeping the genuinely-invisible ones listed as residual blind spots. Everything
here is **advisory**: it is computed after the risk verdict and never feeds back
into it, so the `PreToolUse` gate stays deterministic (same guarantee as
`priorHints`).

- **Symbol-name-as-string.** For each analyzed symbol, search string literals
  across the repo for the symbol's name (`"OrderService"`). Reflection, DI by
  convention, serialization and config reference types by name, not by a resolved
  call. A hit is a *possible* hidden dependency.
- **Table-name in SQL / migrations.** Derive candidate table names from entity
  symbols (naive pluralization) and search `.sql` files, migration directories and
  string literals containing SQL. Surfaces hardcoded SQL the call graph cannot see.
- **Dynamic-construct flags.** Flag the presence of reflection / convention-DI
  APIs (`Type.GetType`, `Activator.CreateInstance`, `services.Scan`, `app(`) and
  concatenated route construction (`"/api/" + x`) near the change.
- **Weight template bindings.** Hits inside view templates (`.razor`, `.cshtml`,
  `.blade.php`) are already found by the name search; surface them distinctly.
- **New report section "Hidden-dependency checks"** — lists what was *searched and
  found*, distinct from the residual "Blind spots" list.
- Unit tests + recalibration.

Outcome: roughly half of the current blind-spot list moves from "blind" to
"checked"; the rest (see P5) stays honestly listed.

**Shipped** in `lib/hidden.js`, wired into `lib/analyze.js` (advisory, after the
risk verdict), rendered by `lib/report.js` as the "Hidden-dependency checks"
section and exposed as `hiddenChecks[]` in `.impact/latest.json`. Covered by unit
tests in `test/unit.js`. The template-binding weighting is intentionally left out
for now (view bindings that name the symbol are already caught by the reference
search; those that do not remain a residual blind spot).

## P2 — Empirical validation · effort M · **the real scientific gap** · shipped

The tool is a heuristic; its precision/recall was unmeasured. This is the step
that turns "plausible" into "credible".

- Transaction-based precision/recall of the **coupling predictor**, using the
  standard MSR leave-out method (Zimmermann et al.): each commit is a transaction,
  one file is the query seed, the rest is predicted from **prior history only**
  (temporal, leakage-free), and the prediction is scored against what actually
  co-changed.
- A threshold **sweep** over `couplingMinCommits` × `couplingMinRatio`, so each
  repo can be tuned from data instead of intuition.
- `git revert` commits are available as a weak incident oracle (`recentReverts`,
  already used by `impact record --from-reverts`) for a future risk-precision
  check.

**Shipped**: pure engine `lib/validate.js` (`evaluateCoupling` / `evaluateAt`)
over an explicit commit list — enabled by extracting `git.couplingFrom` from
`git.coupling` — plus the CLI runner `test/validate.js`
(`node test/validate.js <repo> [--window N] [--json]`). Unit tests in
`test/unit.js`. See [07-git-historical-coupling.md](07-git-historical-coupling.md#11-validation)
for the method and its honest caveats.

**Scope, stated honestly.** This validates the **coupling** signal only — the
language-agnostic core. The static fan-in signal needs a resolved-symbol oracle
to score (P4) and is not measured yet. Recall is a conservative lower bound
(first-time pairings are unpredictable by any co-change model). A labelled
incident set beyond `git revert` remains future work and gates the learned layer.

## P3 — Transitive impact (2 hops) · effort M · **biggest practical gap** · planned

Today the analysis is one hop (direct callers). The most common real-world miss
is indirect impact `A → B → C`.

- Extend `references` recursively to depth 2, capped.
- Report an explicit **"indirect impact"** section, clearly separated from direct
  callers and labelled with its (lower) confidence.

See [09-limitations-and-validity.md](09-limitations-and-validity.md) for why full
transitive reachability is out of scope without a resolved graph.

## P4 — Resolved graph for .NET (Roslyn) · effort L · optional · planned

- When a build is available, an optional Roslyn resolver
  (`MSBuildWorkspace` + `SymbolFinder`) replaces the name search: real call edges,
  overloads distinguished, homonym false positives eliminated.
- Enables fan-out / out-degree and, potentially, centrality measures.
- Requires a passing build, so it degrades to the lexical path where that is
  unavailable. See [04-algorithms-and-complexity.md](04-algorithms-and-complexity.md).

## P5 — Runtime confirmation (observability) · effort L · planned

The only real cover for dependencies configured **in the database** (jobs,
business rules, feature flags) and for reflection.

- Ingest OpenTelemetry traces, SQL logs, a DI-container dump, or a feature-flag
  service API.
- Confirm and weight the static edges with observed runtime behavior.

Until this exists, DB-configured behavior remains an honest residual blind spot.

## P6 — Cross-repo shared index · effort L · planned

- Serialize the per-repo symbol graph and publish it, so cross-repo analysis
  becomes deterministic instead of the current capped name search.

## Later — learned risk layer · planned

- Feed a store of `(impact report, incident occurred or not)` pairs and train a
  learned risk scoring of the diff. Reference: DRS-OSS. Not to be attempted before
  several hundred real pairs exist (depends on P2).

---

## Sequencing

**P1 → P2 → P3** is the committed near-term order: immediate value, then proof it
works, then the biggest practical gap. **P4 / P5 / P6** are gated on genuine
adoption — pursuing them earlier would be over-engineering.

The single metric that decides the tool's survival is the **false-positive /
noise rate** (see [09-limitations-and-validity.md](09-limitations-and-validity.md)
and the README's "The real product risk"). Every phase above is judged against it.
