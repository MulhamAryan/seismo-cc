# seismo-cc — Technical Documentation

In-depth documentation of how seismo-cc works: the architecture, the scientific concepts it rests on, the formal model with equations, the algorithms and their complexity, the analysis pipeline, the risk model, the historical-coupling engine, the full configuration reference, and an honest account of its limitations.

> **What seismo-cc is — in one sentence.** A dependency-free change-impact aid that, before you edit code, surfaces the *blast radius* of a symbol or file by combining three signals: a **textual reference search** (direct callers / fan-in), **git evolutionary coupling** (which files historically change together, $\widehat{P}(B\mid A)$), and **rule-based risk detection** (irreversible operations, public surface). It is a **heuristic**, not sound static analysis — it needs no build, no AST, no type resolution, and it does **not** compute transitive reachability or graph centrality. The documents below are precise about exactly where that line falls.

## How to read this

If you want to understand the tool conceptually, read in order. If you are here for a specific fact, jump to the relevant document.

| # | Document | What it answers |
|---|----------|-----------------|
| — | [Root README](../README.md) · [INSTALL](../INSTALL.md) | What it is at a glance; how to install it (Claude Code plugin, CLI, MCP). |
| 01 | [Architecture](01-architecture.md) | The "one engine, two transports" design; CLI vs MCP; the `PreToolUse` guard; plugin packaging. |
| 02 | [Scientific Concepts](02-scientific-concepts.md) | Change Impact Analysis, blast radius, software-as-a-graph, static vs. lexical analysis, evolutionary coupling — and which of these seismo-cc actually realizes. |
| 03 | [Mathematical Model](03-mathematical-model.md) | The formal model: fan-in, the co-change confidence $r(A\to B)=\widehat{P}(B\mid A)$, the risk lattice, the gate predicate, content fingerprints — each equation tied to a `file:line`. |
| 04 | [Algorithms & Complexity](04-algorithms-and-complexity.md) | Every algorithm step by step (walk, declaration extraction, noise stripping, import-graph disambiguation, reference search, coupling mining) with complexity bounds. |
| 05 | [Analysis Pipeline](05-analysis-pipeline.md) | A full end-to-end run: the five stages of `run()`, `persist()`, the gate decision, the advisory memory layer, and a worked example. |
| 06 | [Risk Model](06-risk-model.md) | The four-level escalation ladder, the exact triggers and thresholds, the irreversible-operation catalogue and weights, API-surface and breaking-change detection. |
| 07 | [Git Historical Coupling](07-git-historical-coupling.md) | The tool's strongest, language-agnostic signal: support, co-change, ratio, windowing, merge dedup, thresholds, with a worked micro-example. |
| 08 | [Configuration Reference](08-configuration-reference.md) | Every configuration field, its default and effect; calibration guidance; environment variables. |
| 09 | [Limitations & Validity](09-limitations-and-validity.md) | A self-critical, research-grade account of what the tool does **not** compute, its precision/recall threats, and the path to higher rigor. |
| — | [Roadmap](ROADMAP.md) | What shipped (P1 hidden-dependency checks, P2 empirical validation, P3 indirect impact) and what is deliberately out of scope. |

## Notation used across the documents

To keep the formal parts consistent, the documents share one set of symbols:

- $G=(V,E)$ — the software modeled as a directed graph. $V$ = symbols and files; there are **two distinct edge relations**: $E_{\text{ref}}$ (a lexical reference from one file to a symbol) and $E_{\text{cochange}}$ (two files that changed together in history).
- $\mathrm{FanIn}(v)$ — the number of files that reference $v$ (an in-degree **approximation**, computed by textual search, one hop only).
- $\mathrm{support}(A)$ — the number of commits (in the last `gitDepth` commits) that touch file $A$.
- $\mathrm{cochange}(A,B)$ — the number of those commits that touch both $A$ and $B$.
- $r(A\to B)=\dfrac{\mathrm{cochange}(A,B)}{\mathrm{support}(A)}=\widehat{P}(B\in c \mid A\in c)$ — the evolutionary-coupling **confidence** (an association-rule confidence; note $r(A\to B)\ne r(B\to A)$).
- The risk levels form an ordered lattice $\texttt{low} < \texttt{moderate} < \texttt{high} < \texttt{blocking}$; the final risk is a **monotone** join (max) over triggered rules.
- $h(f)=\mathrm{SHA1}(\text{content}(f))$ — the content fingerprint the gate uses to detect staleness.

## What seismo-cc deliberately does *not* compute

Stated up front so no document overclaims — see [09-limitations-and-validity.md](09-limitations-and-validity.md) for the full treatment:

- the **transitive reachable set** $\mathrm{Reachable}(v)$ (only direct, one-hop callers);
- **shortest-path impact depth**;
- **fan-out** / out-degree;
- **coupling-between-objects (CBO)** and any **centrality** (degree / betweenness / closeness / eigenvector);
- **edge-weighted propagation** or path counting.

These are out of scope by design: computing them soundly requires a build, an AST, and type resolution, which would break the "drops into any repo with no build" property that makes the historical-coupling signal usable everywhere.

## Source of truth

Every factual claim in these documents is grounded in the code and cites `file:line` (repo-relative, e.g. `lib/git.js:98`). If a document and the code disagree, the code wins — please open an issue or a PR.
