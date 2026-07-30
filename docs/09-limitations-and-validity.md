# 09 — Limitations and Threats to Validity

> A rigorous, self-critical account of what `seismo-cc` is and — more importantly — what it is **not**. This is the document where the tool's scientific boundaries are stated plainly, without marketing. If you take one thing from it: `seismo-cc` is a **heuristic change-impact aid**, not a sound program analysis. Treat every result as a *prior* that narrows human attention, never as a *proof* of impact.

## Abstract

`seismo-cc` estimates the blast radius of a code change by fusing three cheap, build-free signals: (1) a **textual reference search** over language-specific regexes with comment/string stripping and an import-graph confidence overlay ([`lib/scan.js`](../lib/scan.js)); (2) **evolutionary (co-change) coupling** mined from git history ([`lib/git.js`](../lib/git.js)); and (3) a **rule-based risk classifier** over irreversible operations, caller counts, and public surface (`lib/rules.js`). None of these requires a compiler, an AST, a type resolver, or a hosted service. That is the design's central virtue — it drops into ~100 heterogeneous repos with no build — and simultaneously the root of every limitation catalogued here. This document positions the tool against sound static change-impact analysis (CIA), enumerates what it provably does **not** compute and *why*, dissects its precision/recall and construct-validity threats, explains the deliberate determinism boundary around the advisory memory layer, and lays out the path to higher rigor — culminating in the one scientific step the project has not yet taken: **empirical validation against a labelled set of real changes and incidents.**

## Table of contents

1. [Position statement](#1-position-statement)
2. [What `seismo-cc` does not compute](#2-what-seismo-cc-does-not-compute)
3. [Precision and recall threats](#3-precision-and-recall-threats)
4. [Construct validity of the co-change signal](#4-construct-validity-of-the-co-change-signal)
5. [The determinism boundary](#5-the-determinism-boundary)
6. [Comparison: seismo-cc vs. sound CIA vs. pure grep](#6-comparison-seismo-cc-vs-sound-cia-vs-pure-grep)
7. [Path to higher rigor](#7-path-to-higher-rigor)
8. [Summary of validity threats](#8-summary-of-validity-threats)

Related reading: [02 — Scientific concepts](./02-scientific-concepts.md) · [03 — Mathematical model](./03-mathematical-model.md) · [04 — Algorithms and complexity](./04-algorithms-and-complexity.md) · [07 — Git historical coupling](./07-git-historical-coupling.md).

---

## 1. Position statement

`seismo-cc` is a **heuristic** change-impact aid. Concretely, it is the composition of three approximations:

- **Textual reference search.** For each analyzed symbol it runs a word-boundary regex over the tree after a *rough* strip of comments and string literals, then annotates each hit with a confidence tier derived from an import graph. The engine itself is explicit that this is a conscious trade-off, not an oversight — see the comment block at [`lib/scan.js:84-89`](../lib/scan.js#L84): *"Deliberately based on regular expressions rather than a parser… at the cost of false negatives on exotic cases."*
- **Evolutionary coupling.** For each file it mines the last `gitDepth` commits and reports files that changed *together* often enough to clear a support/confidence floor ([`lib/git.js:80-105`](../lib/git.js#L80)).
- **Rule-based risk.** A monotone escalation ladder over irreversible-operation weights, caller thresholds, and public-surface / consumer flags (`lib/rules.js`; ladder reproduced in the README risk section).

To be fair to the tool and honest with its users, it is worth stating precisely what it is **not**:

- It is **not sound static analysis.** It never builds a call graph from semantics; it matches names in text. A "caller" is a *textual co-occurrence of a name*, not a proven invocation edge.
- It is **not reachability analysis or program slicing.** It computes no transitive closure over a dependence graph, no data/control-flow slice, no def-use chains.
- It is **not graph-centrality CIA.** It builds no materialized dependency graph and therefore computes none of the centrality/propagation metrics that graph-based CIA relies on (§2).

What it *is*, honestly framed: a fast, language-agnostic **attention router**. It answers "where should a human look first, and how nervous should they be?" with signals that are individually weak but jointly useful — and it is explicit, in the report's own "Blind spots" section and in [README "Known limitations"](../README.md#known-limitations--read-before-trusting-it), about where it is blind. The correct mental model is a **triage prior**, not an oracle.

---

## 2. What `seismo-cc` does not compute

Every item below is a standard quantity in graph-based or dataflow CIA. Each is *out of scope by construction*, because computing it correctly requires a semantic model of the program — a build, an AST, and type/symbol resolution — which the tool deliberately forgoes to remain build-free. Notation follows [03 — Mathematical model](./03-mathematical-model.md): let $G = (V, E)$ be the (hypothetical) dependency graph over program entities $V$ with directed dependence edges $E$, and let $v \in V$ be a changed entity.

| Quantity | Definition | Why it is out of scope without a build/AST |
|---|---|---|
| **Transitive reachable set** $\mathrm{Reachable}(v)$ | $\lbrace u \in V : v \leadsto u\rbrace $, the set reachable from $v$ over $E$ | There is no $E$. Edges would require resolved call/type references; the tool only has textual name hits, which are neither sound (homonyms) nor complete (reflection, DI). A closure over a wrong edge set is a wrong closure. **Partial mitigation:** a bounded, report-only **2-hop** indirect impact is computed (`lib/transitive.js`, ROADMAP P3) — direct callers → the types they declare → who references those — but this is one extra lexical hop, capped and lower-confidence, not the closure. |
| **Shortest-path impact depth** $d(v,u)=\mathrm{dist}_G(v,u)$ | Number of dependence hops from $v$ to $u$ | Requires $E$ and a BFS/Dijkstra over it. No graph is materialized (see [04 — Algorithms](./04-algorithms-and-complexity.md)); the tool reports *direct* textual co-occurrences and *historical* co-change, neither of which is a path length. |
| **Fan-out / out-degree** $\deg^{+}(v)=\lvert\lbrace (v,u)\in E\rbrace \rvert$ | Count of entities $v$ directly depends on | Out-degree needs resolved outgoing edges. The reference search is *incoming*-oriented (who mentions this name) and unresolved, so even in-degree is an approximation and out-degree is simply not attempted. |
| **Coupling Between Objects (CBO)** | Number of other classes a class is coupled to (Chidamber–Kemerer) | A metric over a resolved type/reference graph. Distinguishing a real coupling edge from a homonym requires type resolution the tool does not have. |
| **Degree / betweenness / closeness / eigenvector centrality** | Structural importance of $v$ in $G$ | All are functions of $G$. Betweenness in particular is $\Theta(VE)$ via Brandes and presupposes a trustworthy $E$. With no materialized graph there is nothing to run them on. |
| **Edge-weighted propagation** | Impact score decaying along weighted paths, e.g. $I(u)=\sum_{\pi: v\leadsto u}\prod_{e\in\pi} w(e)$ | Needs both edges and calibrated edge weights. The tool has *two disjoint* weak signals (textual count, co-change ratio) and does not fuse them into a propagating edge weight. |
| **Path counting** | Number of distinct dependence paths $v \leadsto u$ | A graph-enumeration quantity; undefined without $E$. |

The honest one-line summary: **`seismo-cc` reports a flat, direct, unresolved neighbourhood plus a historical correlation — never a transitive, weighted, semantic graph quantity.** Anyone who reads a caller count as "reachable set size" or a coupling ratio as "propagation probability along an edge" is over-reading the output.

---

## 3. Precision and recall threats

Textual + historical signals trade soundness and completeness for universality. The failures are systematic and worth naming precisely.

### 3.1 False negatives (missed impact — recall < 1)

The reference search only finds a symbol where its **name appears literally in source text after strip**. Any binding that does not surface the name textually is invisible to it:

- **Reflection / dynamic dispatch** — `Activator.CreateInstance`, `MethodInfo.Invoke`: the target type/method name is a runtime string or computed value, never a lexical reference.
- **`Type.GetType(...)` and string-keyed type loading** — the type name lives inside a string literal, which `stripNoise` ([`lib/scan.js:194-219`](../lib/scan.js#L194)) *removes* precisely so that string contents do not inflate counts. Correct for precision, fatal for recall on this pattern.
- **Convention-based DI** — `services.AddScoped<IFoo, Foo>()` wiring, or assembly-scanning registration where the binding is by convention, not by a named call site.
- **Hardcoded / stored SQL, views, stored procedures, triggers** — a column or table rename impacting a `.sql` blob or a DB-side trigger has no C#/PHP symbol to match.
- **DB-driven jobs and feature flags** — a scheduler row or a flag in a config table that decides whether code runs; nothing in the repo text references the changed symbol.
- **Concatenated / computed URLs and routes** — `"/api/" + version + "/checkout"`: the route is assembled at runtime and does not appear as a matchable literal.
- **Unnamed template bindings** — Razor/Blade/Compose bindings that resolve by convention or by property reflection rather than an explicit named reference.

**Active mitigation (P1 hidden-dependency checks).** Beyond coupling, `lib/hidden.js` now *actively searches* part of this surface and reports it (advisory, never affecting risk): the symbol name inside string literals (reflection / DI / serialization / config), an entity's table name in SQL statements (hardcoded SQL), reflection / convention-DI API constructs, and routes built by concatenation. This turns part of the list below from "blind" into "searched and reported" — but the search is lexical and heuristic, so it raises recall on this surface without ever reaching soundness. Database-configured jobs / rules / feature flags remain out of reach without runtime/DB introspection (see [ROADMAP.md](./ROADMAP.md) P5).

**Mitigation, honestly bounded.** [Historical coupling](./07-git-historical-coupling.md) recovers *some* of these — precisely because it is language-agnostic and semantics-blind, it catches "the SQL file always changes with this repository", "this DI module co-changes with that service", "these docs must be updated together" ([`lib/git.js:74-79`](../lib/git.js#L74)). But it only recovers what has *co-changed in the observed window before* (§4). A dependency that exists but has never been exercised together in history is invisible to both signals. Recall is therefore strictly below 1, and the missed set is not random — it is exactly the dynamic/config-driven surface, which is often the highest-risk surface.

### 3.2 False positives (spurious impact — precision < 1)

The reference search matches **names**, and names are not unique:

- **Homonyms across namespaces/modules.** Without type resolution, `Order` in `App\Billing` and `Order` in `App\Reporting` are the same token. The engine says so at [`lib/scan.js` (namespace heuristic, L154-167)](../lib/scan.js#L154) and [README "No type resolution"](../README.md#known-limitations--read-before-trusting-it): *"`Order` in two namespaces is the same symbol."*
- **Overloads not distinguished.** `Handle(int)` and `Handle(string)` collapse to one symbol; the tool cannot attribute a call site to a specific overload.
- **Generic / high-frequency names.** `Status`, `Handle`, `Get`, `Run` produce noise wherever the word appears.

**Mitigations in place — and their ceiling.** Three mechanisms reduce, but do not eliminate, this:

1. **The `NOISE` filter** ([`lib/scan.js:142-146`](../lib/scan.js#L142)) drops the most generic identifiers (`Main`, `Handle`, `Status`-class names, `Get`/`Set`/`Run`, CRUD verbs) and any name shorter than 3 chars ([`lib/scan.js:132`](../lib/scan.js#L132)) from *declaration* extraction. This trades recall for precision by design: a legitimately named `Handle` method will simply not be analyzed.
2. **Types-first / qualified-site weighting.** A preceding `.`, `->`, `::`, `new`, or `instanceof` ([`qualifierBefore`, `lib/scan.js:304-316`](../lib/scan.js#L304)) marks a hit as a *strong* site; the `(?<![\w$])` lookbehind ([`lib/scan.js:338`](../lib/scan.js#L338)) rejects `$order` PHP/JS variables a plain `\b` would have matched.
3. **Confidence tiers via the import graph** ([`lib/scan.js:333-411`](../lib/scan.js#L333)). A file importing the *exact* declaration path (`use App\Billing\Order`) is `high`; a file importing a *same-named symbol from another module* is downgraded to `low` even if its sites are qualified ([`lib/scan.js:359-362, 386-394`](../lib/scan.js#L359)); an ambiguous homonym with no signal is `low`.

The ceiling is structural: **confidence is an annotation, not a filter.** By explicit design the tiers are *additive* — the raw `count`/`occurrences` that feed the risk score are unchanged ([`lib/scan.js:398-403`](../lib/scan.js#L398), and [README "Improved non-.NET resolution"](../README.md#improved-non-net-resolution): *"the raw call-site counts feeding the risk score are unchanged"*). So a `low`-confidence homonym still contributes to the caller count that can escalate risk. The tiers help a human reading the report; they do not make the underlying resolution sound. And for TypeScript, `importPathFor` returns `null` ([`lib/scan.js:273-276`](../lib/scan.js#L273)) because the import specifier is a file path, not a symbol path — so cross-module homonym disambiguation is weaker there than in PHP/Kotlin.

---

## 4. Construct validity of the co-change signal

Evolutionary coupling is the tool's most valuable signal, but it measures **temporal correlation in commit history**, and there is a genuine gap between that construct and the one we care about — *causal dependency*. Four threats:

- **Correlation ≠ causation.** Two files co-changing in 90% of commits may share a real dependency, or may merely be co-owned by one team, touched by the same sweeping formatting commit, or coincidentally active in the same sprint. The ratio $r = n/|\text{touching}|$ ([`lib/git.js:97`](../lib/git.js#L97)) is $P(\text{other changed} \mid \text{target changed})$ over the window — a conditional frequency, not evidence of a code-level edge. See [02 — Scientific concepts](./02-scientific-concepts.md) and [07 — Git historical coupling](./07-git-historical-coupling.md) for the derivation.
- **Window-size sensitivity (`gitDepth`).** The signal is computed over the last `depth` commits (default 400, [`lib/git.js:81`](../lib/git.js#L81)). Too small a window starves the estimator (nothing clears `minCommits`); too large a window dilutes recent architecture with long-dead structure and lets a since-deleted coupling dominate. The reported ratio is not a stable population parameter — it is an estimate whose value **depends on a tunable that the analyst rarely revisits**. Two runs with different `depth` on the same repo can legitimately disagree.
- **Spurious co-commits.** Mega-commits (a repo-wide rename, a `.editorconfig` reformat, a dependency bump touching every project file) inject co-change edges between files with no logical relationship. The engine mitigates *merge* double-counting — `-m` makes a merge appear once per parent and `parseLog` dedupes by SHA ([`lib/git.js:115-147`](../lib/git.js#L115)) — but it does **not** filter by commit size, so a single 300-file commit still couples all 300 files pairwise in the counts.
- **Cold-start / insufficient history.** A file touched by fewer than `minCommits` (default 3) commits yields *no* coupling at all ([`lib/git.js:88`](../lib/git.js#L88)); the whole history section is empty on a young repo or a brand-new file ([README "New repo = no coupling"](../README.md#known-limitations--read-before-trusting-it)). This is deliberate — below the floor it is noise, not signal — but it means the tool's best signal is exactly absent when a file is new, which is often when a change is riskiest.

Construct-validity bottom line: the co-change number answers "how often did these move together lately?", and the analyst must not silently promote it to "how likely is changing A to break B?". The two coincide only under assumptions (stable window, no mega-commits, causal co-ownership) the tool cannot verify.

---

## 5. The determinism boundary

The advisory prior-incident layer (`priorHints`, backed by *seismo-memory*) is **deliberately excluded from the risk and gate computation.** This is not an accident of implementation; it is a validity-preserving design decision, and it matters for exactly one reason: **reproducibility.**

The contract, stated in [README "Prior incidents"](../README.md#prior-incidents--priorhints-advisory-seismo-memory): *"`priorHints` never affects `risk.level` and never affects the gate decision — both stay deterministic, computed by `lib/rules.js` from the analysis alone… Same diff, same verdict, whatever the incident history — the gate stays reproducible."*

Why this boundary is scientifically important:

1. **A reproducible gate is a testable gate.** Because `risk.level` is a pure function of the analysis (irreversible weights, caller counts, surface flags) and never of accumulated incident history, the same diff on the same commit yields the same verdict on every machine, every run. If incident history fed the score, the gate would be **path-dependent** — its decision on a diff today would differ from the identical diff last month purely because incidents accrued in between. That is untestable and unauditable: you could never reproduce a past "block" decision, and calibration (§7) would be chasing a moving target.
2. **It keeps the confound out of the classifier.** Feeding "this symbol caused incidents before" into the risk score would entangle two things we want to keep separable for eventual validation: the *structural* risk of the current change, and the *historical* incident-proneness of the area. Mixing them makes it impossible to measure the structural classifier's precision/recall independently (§7).
3. **It fails safe and offline.** The layer degrades to empty when `memoryPath` is unset, absent, unreadable, or corrupt, and never throws ([README](../README.md#prior-incidents--priorhints-advisory-seismo-memory)). A gate whose decision depended on it would inherit that fragility; an advisory-only layer cannot.

So `priorHints` is *context for the human*, printed in the report, and nothing more. The determinism boundary is the line between "information that helps a person decide" and "input that changes an automated verdict" — and the tool keeps the automated verdict on the deterministic side of that line on purpose.

---

## 6. Comparison: seismo-cc vs. sound CIA vs. pure grep

Positioning the tool on the accuracy/cost frontier. "Sound CIA" here means a semantics-based approach such as Roslyn `SymbolFinder.FindReferencesAsync` (or tree-sitter + resolved symbol table) plus dataflow/reachability; "pure grep" is a bare `grep symbol -r`.

| Dimension | Pure `grep` | **`seismo-cc`** | Sound CIA (Roslyn `SymbolFinder` / AST + dataflow) |
|---|---|---|---|
| **Soundness** (edges are real) | None — matches any text, incl. comments/strings/homonyms | Heuristic — strips comments/strings, weights by import graph & qualifier, but unresolved; homonyms/overloads remain | Sound (per language semantics) — resolved symbols, overloads distinguished |
| **Completeness on dynamic surface** | Only literal name hits | Literal hits **+ historical coupling** recovers *some* reflection/DI/SQL/config | Static analysis alone still misses reflection/DI/config unless modelled; no history signal |
| **Build requirement** | None | **None** — no compile, no NuGet, no AST | Requires a passing build / resolvable project (unusable on part of a heterogeneous fleet) |
| **Language coverage** | Any (text) | .NET first-class; PHP/Kotlin/TS best-effort; **git coupling any language** | Per-analyzer; each language needs its own resolver and green build |
| **Transitive impact** | None | None (direct neighbourhood + co-change only, §2) | Yes — transitive reachability, slicing, centrality, weighted propagation |
| **Determinism** | Deterministic | Deterministic gate (advisory memory excluded, §5) | Deterministic given a fixed build |
| **Cost / latency** | Trivial | Low — regex sweep + `git log`, cached, runs inside a `PreToolUse` hook | High — build + workspace load + graph construction; often minutes; infeasible per-keystroke |
| **False-positive rate** | High | Moderate (NOISE filter + tiers reduce, don't eliminate) | Low |
| **Cross-repo** | Manual | Capped name search ("flags, doesn't prove", [README](../README.md#known-limitations--read-before-trusting-it)) | Deterministic only with a shared serialized index |

Read this table as a frontier, not a ranking: `seismo-cc` deliberately sits **between** grep and sound CIA — strictly more informative than grep (strip, tiers, coupling, risk rules, gate), strictly less rigorous than a resolved-symbol analysis, and uniquely able to run where a build is unavailable. Its reason to exist is the middle cell of the "build requirement" row: it delivers a useful prior in the very repos where sound CIA cannot even start.

---

## 7. Path to higher rigor

This mirrors the [README "Path to v2"](../README.md#path-to-v2) but frames each step as closing a specific validity gap. Order matters — do this only if v1 is genuinely adopted.

1. **Exact resolution (Roslyn / tree-sitter).** Replace the regex reference search with `MSBuildWorkspace` + `SymbolFinder.FindReferencesAsync` for .NET, and resolved tree-sitter symbol tables elsewhere. This directly closes §3.2 (homonyms, overloads) and much of §3.1's static portion. **Cost, stated honestly:** it needs a green build, so it is unusable on part of the fleet — which is why it is an *upgrade path*, not a replacement of the build-free engine.
2. **Materialized dependency graph $G=(V,E)$.** Once references are resolved, persist the graph. This is the enabling step for every quantity in §2:
   - **BFS reachability** for $\mathrm{Reachable}(v)$ and impact depth $d(v,u)$ in $O(V+E)$.
   - **Brandes betweenness** for centrality-based CIA in $O(VE)$ (unweighted) / $O(VE + V^2\log V)$ (weighted) — see [04 — Algorithms and complexity](./04-algorithms-and-complexity.md) for the complexity treatment these figures belong to.
   - fan-out, CBO, path counting — all become well-defined.
3. **Edge-weighted propagation fusing static structure with $P(B \mid A)$.** Today the static count and the co-change ratio are two disjoint weak signals (§4, §6). With a graph in hand, fuse them into a single edge weight $w(A \to B) = f(\text{static edge strength}, \; P(B \text{ changes} \mid A \text{ changes}))$ and propagate an impact score along paths ($I(u)=\sum_\pi \prod_{e\in\pi} w(e)$). This turns the flat neighbourhood into a graded, distance-aware blast radius and finally uses the historical signal as *evidence on an edge* rather than a parallel list.
4. **Empirical validation — the missing scientific step.** Everything above improves the *mechanism*; none of it tells us whether the tool is *correct*. The one step the project has **not** taken, and the one that would move it from "plausible heuristic" to "validated instrument", is measuring **precision and recall against a labelled ground-truth set of real changes and incidents.** Concretely:
   - assemble a corpus of historical changes with known downstream impact (from incidents, reverts — [`recentReverts`, `lib/git.js:175-194`](../lib/git.js#L175) already mines these — regression tickets, and post-hoc "what actually broke" labels);
   - for each, compare the tool's predicted blast radius against the observed one and compute precision, recall, and calibration of the risk levels;
   - tune `NOISE`, confidence thresholds, `gitDepth`, `minCommits`, `minRatio`, and the `rules.js` thresholds *against that measurement* rather than against intuition.

   Until this exists, every accuracy claim in this repository — including the confidence tiers and the risk ladder — is an **engineering argument, not an empirical result.** The learned-risk layer floated in the README (DRS-OSS, arXiv:2511.21964) is a *consequence* of this step, not a substitute for it: you cannot train or trust a scorer without labelled pairs, and you cannot claim the heuristic works without measuring it against reality.

---

## 8. Summary of validity threats

Framed in standard empirical-software-engineering terms:

| Threat class | Concrete instance in `seismo-cc` | Current mitigation | Residual risk |
|---|---|---|---|
| **Construct validity** | Co-change frequency used as a proxy for causal dependency; caller *count* used as a proxy for impact | Report labels signals by confidence ("textual", "historical (deterministic)"); §4 documents the gap | The proxy gap is real and unmeasured |
| **Internal validity** | Homonyms/overloads inflate caller counts that feed risk; mega-commits inflate coupling | NOISE filter, qualifier/import tiers, merge dedup | Tiers are additive, not filtering; no commit-size filter |
| **External validity** | Calibrated on .NET; best-effort on PHP/Kotlin/TS; validated on synthetic fixtures | Language adapters; calibration guidance in README | Not run inside Claude Code end-to-end ([README](../README.md#known-limitations--read-before-trusting-it)); no field study |
| **Conclusion validity** | No labelled outcome set → accuracy claims are unfalsified | Determinism boundary keeps the gate reproducible (§5), so a future study *can* be run | Precision/recall unknown until §7.4 is done |
| **Reliability / reproducibility** | Verdict must not drift over time | Advisory memory excluded from score/gate; pure-function risk (§5) | `gitDepth`-dependence of coupling across runs (§4) |

The tool is, by its authors' own framing, a **noise-threshold product** ([README "The real product risk"](../README.md#the-real-product-risk)): its danger is not imprecision per se but crying wolf until it is ignored. This document exists so that no one mistakes a useful triage prior for a sound impact proof — and so that the single step separating the two, empirical validation against real changes and incidents (§7.4), is named plainly as unfinished.
