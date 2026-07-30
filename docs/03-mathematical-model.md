# The Formal Model of seismo-cc

> **Abstract.** This document is the precise mathematical specification of what
> seismo-cc computes. It fixes a single notation and then formalizes every
> quantity *exactly* as the code produces it — fan-in, evolutionary (co-change)
> coupling, reference confidence, the risk lattice, the content fingerprint, and
> the gate's freshness predicate — each tied to a concrete `file:line` anchor in
> the implementation. The framing is deliberately honest: seismo-cc is a
> **heuristic**. Its regexes approximate a parser, its coupling approximates
> causality, and its risk score is a transparent escalation over a four-element
> lattice, not a calibrated probability. Where a symbol denotes an *estimate* we
> say so; where a quantity is *not* modeled (transitive reachability, path depth,
> betweenness, weighted propagation) we list it explicitly in the final section.
> Every formula here should be reproducible by reading the cited source.

---

## Table of contents

1. [Notation](#1-notation)
2. [Fan-in (static reference count)](#2-fan-in-static-reference-count)
3. [Reference confidence tiers](#3-reference-confidence-tiers)
4. [Historical (evolutionary) coupling](#4-historical-evolutionary-coupling)
5. [Irreversibility and public surface](#5-irreversibility-and-public-surface)
6. [The risk lattice](#6-the-risk-lattice)
7. [Content fingerprint and the gate predicate](#7-content-fingerprint-and-the-gate-predicate)
8. [What is NOT modeled](#8-what-is-not-modeled)
9. [Cross-references](#9-cross-references)

---

## 1. Notation

seismo-cc reasons over two overlapping structures on the same repository: a
**static reference structure** derived from text matching, and a **temporal
co-change structure** derived from git history. We model both as relations on a
shared vertex set.

Let the analyzed repository induce a directed graph $G = (V, E)$ where the
vertex set is partitioned into

$$
V \;=\; V_{\mathrm{sym}} \;\sqcup\; V_{\mathrm{file}},
$$

- $V_{\mathrm{sym}}$ — **symbols**: types (`class`/`record`/`struct`/`interface`/`enum`) and
  members (methods, properties) extracted by the language adapters in
  `lib/scan.js:90-138` (`DECL`, `declarations`). Only names of length $\ge 3$
  that are not in the `NOISE` set survive (`lib/scan.js:132-133`, `142-146`).
- $V_{\mathrm{file}}$ — **files**: repository-relative source paths that pass the
  extension filter and ignore rules (`lib/scan.js:28-51`, `walk`; `lib/config.js:8-14`).

Two edge relations are defined on $V$:

- **Static reference edges** $E_{\mathrm{ref}} \subseteq V_{\mathrm{file}} \times V_{\mathrm{sym}}$.
  We write $f \xrightarrow{\mathrm{ref}} v$ when file $f$ contains at least one
  textual call site of symbol $v$ (excluding $v$'s own declaration line and any
  `import`/`use` line), as computed by `references` in `lib/scan.js:333-411`.
- **Co-change edges** $E_{\mathrm{cc}} \subseteq V_{\mathrm{file}} \times V_{\mathrm{file}}$.
  We write $A \xrightarrow{\mathrm{cc}} B$ when files $A$ and $B$ appear together
  in at least one commit within the analyzed history window, weighted by how
  often (Section 4, `lib/git.js:80-105`).

Let $\mathcal{C}$ denote the multiset-free set of commits in the analysis window
(after the deduplication of Section 4.3), and for a commit $c$ let
$\mathrm{files}(c) \subseteq V_{\mathrm{file}}$ be its touched file set. All
thresholds are read from configuration (`lib/config.js:21-27`; mirrored in
`impact.config.example.json:4-10`):

| Symbol | Config key | Default | Anchor |
|---|---|---|---|
| $D$ | `gitDepth` | $400$ | `lib/config.js:19` |
| $k_{\min}$ | `couplingMinCommits` | $3$ | `lib/config.js:24` |
| $r_{\min}$ | `couplingMinRatio` | $0.4$ | `lib/config.js:25` |
| $\tau_{\mathrm{warn}}$ | `callersWarn` | $15$ | `lib/config.js:22` |
| $\tau_{\mathrm{high}}$ | `callersHigh` | $40$ | `lib/config.js:23` |
| $T_{\max}$ | `reportMaxAgeMinutes` | $120$ (min) | `lib/config.js:26` |

---

## 2. Fan-in (static reference count)

Fan-in measures how many places depend on a symbol. seismo-cc computes it
**statically and non-transitively**: it counts direct textual references only.

### 2.1 File-level fan-in

For a symbol $v$ with declaring file $\mathrm{decl}(v)$, define the set of
**referencing files**

$$
R(v) \;=\; \bigl\{\, f \in V_{\mathrm{file}} \;:\; f \xrightarrow{\mathrm{ref}} v \,\bigr\},
$$

and the **file fan-in** as its cardinality restricted to files other than the
declaration site:

$$
\mathrm{FanIn}(v) \;=\; \bigl|\{\, f \in R(v) \;:\; f \neq \mathrm{decl}(v) \,\}\bigr|.
$$

In code this is `external.length`, where `external = refs.filter(r => r.file !== declFile)`
(`lib/analyze.js:196`, `202`).

### 2.2 Call-site count (distinct lines)

Within a single referencing file $f$, the reference scan (`lib/scan.js:372-404`)
accumulates matches of the boundary-anchored pattern

$$
\texttt{(?<![\textbackslash w\$])}\; \mathrm{esc}(v)\; \texttt{\textbackslash b}
\qquad(\text{`lib/scan.js:338`})
$$

over the **noise-stripped** content of $f$ (comments and string literals removed
by `stripNoise`, `lib/scan.js:194-219`). Let

- $\mathrm{Lines}(v, f)$ = the set of **distinct source lines** of $f$ carrying at
  least one qualifying match (`lineSet`, `lib/scan.js:366`, `381-384`), and
- $\mathrm{occ}(v, f)$ = the **total number of matches** (`occurrences`,
  `lib/scan.js:368`, `377`).

Then the two counters attached to each hit are

$$
\mathrm{count}(v, f) = \bigl|\mathrm{Lines}(v, f)\bigr|, \qquad
\mathrm{occurrences}(v, f) = \mathrm{occ}(v, f),
$$

with the invariant $\mathrm{count}(v,f) \le \mathrm{occurrences}(v,f)$ (two hits
on one line collapse in `count` but not in `occurrences`).

**`count` vs `occurrences` vs the display cap.** Three distinct quantities must
not be confused:

- **`count`** — distinct matching lines, **uncapped**. This is the number that
  feeds the risk score. `count` is deliberately never truncated
  (`lib/scan.js:366` comment: *"distinct lines, NOT capped: feeds the risk"*).
- **`occurrences`** — raw total match count, also uncapped; informational.
- **display cap $= 50$** — `LINES_SHOWN_MAX` (`lib/scan.js:331`). Only the
  *listed* line numbers (`shownLines`) are capped at 50 for readability
  (`lib/scan.js:383`); `truncated` flags when `count` exceeds the shown list
  (`lib/scan.js:400`). The cap is a rendering concern and has **no effect** on
  the counters that drive risk.

### 2.3 Symbol call-site total and the `callers` aggregate

For a symbol $v$, the code sums distinct-line counts over external referencing
files (`lib/analyze.js:202`):

$$
\mathrm{callSites}(v) \;=\; \sum_{\substack{f \in R(v) \\ f \neq \mathrm{decl}(v)}} \mathrm{count}(v, f).
$$

The scalar consumed by the risk rule is the sum over all analyzed symbols
(`lib/analyze.js:241`):

$$
\mathrm{callers} \;=\; \sum_{v \in \mathrm{Symbols}} \mathrm{callSites}(v).
$$

> **Not transitive.** $E_{\mathrm{ref}}$ is a one-hop relation. If $f$ references
> $v$ and $v$'s body references $w$, seismo-cc does **not** infer $f \to w$.
> $\mathrm{FanIn}$ and $\mathrm{callers}$ are in-degree counts, never reachability
> counts. See Section 8 and `09-limitations-and-validity.md`.

---

## 3. Reference confidence tiers

Because resolution is name-based (no compiler, no type graph), each referencing
file is tagged with a confidence in $\{\textsf{high}, \textsf{normal},
\textsf{low}\}$. The tier annotates the hit; it does **not** alter `count`
(`lib/scan.js:225-227` design note: *"raw count stays unchanged"*). It is used
only as a tie-breaker at equal count in the sort (`lib/scan.js:409-410`).

### 3.1 Signals

For a referencing file $f$ and symbol $v$ with declaring module
$M_{\mathrm{decl}} = \mathrm{moduleOf}(\mathrm{decl}(v))$ (namespace/package;
`lib/scan.js:291-298`, `341-342`), define the following predicates
(`lib/scan.js:356-364`):

- $\mathrm{impPath}(f, v)$ — the full import path bound to the local name $v$ in
  $f$, for PHP/Kotlin (`importPathFor`, `lib/scan.js:273-286`); `null` otherwise.
- $\mathsf{importHere}(f,v) \;\equiv\; \mathrm{impPath}(f,v) = M_{\mathrm{decl}} \,\Vert\, v$
  — $f$ imports **exactly** the sought declaration (`lib/scan.js:360`), where
  $\Vert$ is the language separator (`\` for PHP, `.` otherwise).
- $\mathsf{importElsewhere}(f,v) \;\equiv\; \mathrm{impPath}(f,v) \neq \texttt{null}
  \,\wedge\, M_{\mathrm{decl}} \neq \texttt{null} \,\wedge\, \neg\,\mathsf{importHere}$
  — $f$ imports a **homonym from another module** (`lib/scan.js:361`).
- $\mathsf{fileImports}(f,v) \;\equiv\; \mathsf{importHere} \,\vee\,
  \bigl(\mathrm{impPath} = \texttt{null} \,\wedge\, v \in \mathrm{importedNames}(f)\bigr)$
  (`lib/scan.js:363`).
- $\mathsf{sameModule}(f,v) \;\equiv\; M_{\mathrm{decl}} \neq \texttt{null}
  \,\wedge\, \mathrm{moduleOf}(f) = M_{\mathrm{decl}}$ (`lib/scan.js:364`).
- $\mathsf{strong}(f,v) \;\equiv\;$ at least one match in $f$ is **qualified** —
  preceded by `.`, `->`, `::`, or the keyword `new`/`instanceof`
  (`qualifierBefore`, `lib/scan.js:304-316`; set at `lib/scan.js:379`).
- $\mathsf{ambiguous}(v) \;\equiv\;$ $v$ has more than one declaration site
  (`declSites.length > 1`, `lib/analyze.js:193`).

### 3.2 The tier function

The confidence is assigned by the first matching clause (`lib/scan.js:391-394`):

$$
\mathrm{conf}(f, v) \;=\;
\begin{cases}
\textsf{low} & \text{if } \mathsf{importElsewhere}(f,v),\\[4pt]
\textsf{high} & \text{else if } \mathsf{fileImports}(f,v) \,\vee\, \mathsf{sameModule}(f,v) \,\vee\, \mathsf{strong}(f,v),\\[4pt]
\textsf{low} & \text{else if } \mathsf{ambiguous}(v),\\[4pt]
\textsf{normal} & \text{otherwise.}
\end{cases}
$$

Reading it in words: a file that imports a same-named symbol from a *different*
module does not reference our symbol at all — it is forced to $\textsf{low}$
regardless of how many qualified sites it has. Otherwise, an exact import, being
in the declaring module, or any qualified usage promotes to $\textsf{high}$. A
bare-word match on an ambiguous (multiply-declared) name with no corroborating
signal drops to $\textsf{low}$. Everything else is $\textsf{normal}$.

---

## 4. Historical (evolutionary) coupling

This is the co-change signal: files that *change together in history* are
treated as coupled, independent of any static edge. It is the language-agnostic
core of the tool (`lib/git.js:74-78`).

### 4.1 Support, co-change, confidence

Fix the history window to the last $D$ commits (`gitDepth`). For a **seed file**
$A$ define its **support** — the number of window commits touching $A$:

$$
\mathrm{support}(A) \;=\; \bigl|\{\, c \in \mathcal{C} \;:\; A \in \mathrm{files}(c) \,\}\bigr|
\qquad(\text{`touching`, `lib/git.js:87`}).
$$

For another file $B$ define the **co-change count**:

$$
\mathrm{cochange}(A, B) \;=\; \bigl|\{\, c \in \mathcal{C} \;:\; A \in \mathrm{files}(c) \,\wedge\, B \in \mathrm{files}(c) \,\}\bigr|
\qquad(\text{`counts`, `lib/git.js:89-95`}).
$$

The **coupling ratio** is (`lib/git.js:97`):

$$
r(A \to B) \;=\; \frac{\mathrm{cochange}(A, B)}{\mathrm{support}(A)}.
$$

**Interpretation.** $r(A \to B)$ is precisely the **confidence** of the
association rule $A \Rightarrow B$ in market-basket terms, i.e. the empirical
conditional frequency

$$
r(A \to B) \;=\; \widehat{P}\!\left(B \in \mathrm{files}(c) \;\middle|\; A \in \mathrm{files}(c)\right),
$$

the maximum-likelihood estimate of the probability that a commit touches $B$
*given that* it touches $A$. It is **directional**: in general
$r(A \to B) \neq r(B \to A)$ because the denominators differ. It is a
correlation/association estimate, **not** a causal claim, and it is biased by
the finite window $D$ and by commit granularity. See
`07-git-historical-coupling.md` and `02-scientific-concepts.md`.

### 4.2 The retention filter

A candidate pair $(A, B)$, $B \neq A$, is retained iff **all three** hold
(seed-level guard at `lib/git.js:88`; per-pair guard at `lib/git.js:98`):

$$
\underbrace{\mathrm{support}(A) \;\ge\; k_{\min}}_{\text{`touching.length < minCommits` skips}}
\;\wedge\;
\underbrace{\mathrm{cochange}(A, B) \;\ge\; k_{\min}}_{\texttt{n < minCommits}}
\;\wedge\;
\underbrace{r(A \to B) \;\ge\; r_{\min}}_{\texttt{ratio < minRatio}}.
$$

With defaults $k_{\min} = 3$, $r_{\min} = 0.4$: a file must have moved at least 3
times, must have moved *with* the seed at least 3 times, and must have done so in
$\ge 40\%$ of the seed's commits. The first conjunct kills statistical noise from
rarely-touched seeds; the last is the association-rule confidence threshold.

### 4.3 Deduplication (the `-m` correction)

The history is collected with `git log -n{D} --format=%H --name-only
--no-renames -m --first-parent` (`lib/git.js:118`). The `-m` flag makes merge
commits emit their file list **once per parent**, so the same 40-hex SHA recurs
with overlapping file lists. Without correction, both $\mathrm{support}$ and
$\mathrm{cochange}$ are inflated on merge-heavy histories.

`parseLog` (`lib/git.js:128-147`) corrects this with two dedup layers:

- **by SHA** — repeated SHAs merge into one commit record (`bySha` map,
  `lib/git.js:134-139`);
- **by file within a commit** — a per-commit `_seen` set makes
  $\mathrm{files}(c)$ a true **set**, so a file counts at most once per commit
  (`lib/git.js:141`).

Hence $\mathcal{C}$ in the formulas above is a set of *distinct* commits with
*set-valued* file lists — which is what makes $\mathrm{support}$ and
$\mathrm{cochange}$ well-defined cardinalities.

### 4.4 Multi-seed aggregation and output order

`run` seeds coupling with the union of changed files and symbol declaration files
(`lib/analyze.js:210-213`). When several seeds nominate the same file $B$, only
the **highest-ratio** entry is kept (`lib/git.js:99-102`):

$$
\mathrm{entry}(B) \;=\; \arg\max_{A \,:\, (A,B)\ \text{retained}} \; r(A \to B).
$$

The result list is sorted by ratio descending, ties broken by co-change count
descending (`lib/git.js:104`):

$$
(B_1, B_2, \dots) \ \text{ordered by}\ \bigl(r(A \to B),\ \mathrm{cochange}(A,B)\bigr)\ \text{lexicographically, descending.}
$$

> **Churn** (`churn`, `lib/git.js:153-156`) is a related but separate scalar:
> $\mathrm{churn}(f) = \bigl|\{\text{window commits touching } f\}\bigr|$, computed
> with a pathspec'd `git log ... -- file`. It equals $\mathrm{support}(f)$
> conceptually but is obtained by an independent command and is reported as a
> stability hint; it does not enter the risk formula.

---

## 5. Irreversibility and public surface

Two rule families feed risk. Both are regex families over noise-stripped content
(`lib/config.js:42-65`).

### 5.1 Irreversible operations and their weights

Each rule $\rho \in \mathrm{IRREVERSIBLE}$ carries a weight
$w(\rho) \in \{1,\dots,5\}$ (`lib/config.js:42-55`). `irreversible`
(`lib/rules.js:10-50`) scans both the file contents and the diff text (a removed
line matters as much as an added one, `lib/rules.js:5-9`), deduplicating by
`(rule id, location)` (`lib/rules.js:14-19`). The quantity that reaches risk is
the **maximum weight** among all findings:

$$
W \;=\; \max_{f \in \mathrm{findings}} w(f)
\qquad(\text{`worst`, `lib/rules.js:125`}),
$$

with $W = 0$ when there are no findings. Representative weights:

| Rule id | Weight $w$ | Anchor |
|---|---|---|
| `ef-destructive` (Drop/Alter column/table) | $5$ | `lib/config.js:44` |
| `payment` (Stripe/Mollie/…) | $5$ | `lib/config.js:51` |
| `delete-bulk` (`ExecuteDelete`, `TRUNCATE`, `DELETE FROM`) | $4$ | `lib/config.js:48` |
| `auth` (authorization changed) | $4$ | `lib/config.js:54` |
| `ef-migration`, `laravel-migration`, `raw-sql`, `mail` | $3$ | `lib/config.js:43,45,47,49` |
| `job`, `filesystem` | $2$ | `lib/config.js:50,53` |
| `external-call` | $1$ | `lib/config.js:52` |

### 5.2 Public-surface count

`apiSurfaceOfContent` (`lib/rules.js:73-89`) applies each rule in
$\mathrm{API\_SURFACE}$ (`lib/config.js:58-65`) with a **global** regex, keeping
up to the first 12 matches per rule (`lib/rules.js:77`) and emitting **one
finding per rule that matched**. The scalar consumed by risk is the number of
such findings across inspected files (`lib/analyze.js:242`):

$$
\mathrm{apiSurface} \;=\; \bigl|\{\, \text{surface findings over inspected files} \,\}\bigr|
= \texttt{api.length}.
$$

Note $\mathrm{apiSurface}$ counts *matched rule-instances per file*, not raw
endpoint strings.

---

## 6. The risk lattice

Risk is a value on the totally ordered four-element lattice

$$
\mathcal{L} \;=\; \bigl(\{\,\textsf{low} < \textsf{moderate} < \textsf{high} < \textsf{blocking}\,\}, \ \le\bigr),
$$

with join $\vee = \max_{\mathcal{L}}$. `riskLevel` (`lib/rules.js:120-154`)
starts at $\textsf{low}$ and **escalates monotonically**: every rule can only
raise the level toward $\textsf{blocking}$, never lower it. The final level is
therefore the join of all triggered contributions.

### 6.1 The escalation as a join

Given the summary tuple $(\;W,\ \mathrm{callers},\ \mathrm{apiSurface},\
\mathrm{crossRepo},\ \mathrm{externalConsumers}\;)$ (`lib/analyze.js:240-246`),
each rule contributes a lattice element which is joined in:

$$
\mathrm{risk} \;=\; \ell_{\mathrm{irr}} \;\vee\; \ell_{\mathrm{callers}} \;\vee\; \ell_{\mathrm{api}} \;\vee\; \ell_{\mathrm{cross}} \;\vee\; \ell_{\mathrm{ext}},
$$

where the contributions are, exactly as coded:

**Irreversibility** (`lib/rules.js:125-127`):

$$
\ell_{\mathrm{irr}} \;=\;
\begin{cases}
\textsf{blocking} & W \ge 5,\\
\textsf{high} & 3 \le W \le 4,\\
\textsf{low} & W \le 2.
\end{cases}
$$

**Call sites** (`lib/rules.js:129-135`):

$$
\ell_{\mathrm{callers}} \;=\;
\begin{cases}
\textsf{high} & \mathrm{callers} \ge \tau_{\mathrm{high}}\ (=40),\\
\textsf{moderate} & \tau_{\mathrm{warn}} \le \mathrm{callers} < \tau_{\mathrm{high}}\ \ (15 \le \cdot < 40),\\
\textsf{low} & \mathrm{callers} < \tau_{\mathrm{warn}}.
\end{cases}
$$

**Public surface** (`lib/rules.js:137-140`):

$$
\ell_{\mathrm{api}} \;=\;
\begin{cases}
\textsf{moderate} & \mathrm{apiSurface} > 0,\\
\textsf{low} & \text{otherwise.}
\end{cases}
$$

**Cross-repo consumers** (`lib/rules.js:142-145`):

$$
\ell_{\mathrm{cross}} \;=\;
\begin{cases}
\textsf{high} & \mathrm{crossRepo} > 0,\\
\textsf{low} & \text{otherwise.}
\end{cases}
$$

**Declared external consumer of a modified public surface** (`lib/rules.js:147-150`):

$$
\ell_{\mathrm{ext}} \;=\;
\begin{cases}
\textsf{blocking} & \mathrm{externalConsumers} > 0 \ \wedge\ \mathrm{apiSurface} > 0,\\
\textsf{low} & \text{otherwise.}
\end{cases}
$$

### 6.2 Faithfulness note

The join formulation is exactly equivalent to the imperative code, because every
assignment in `riskLevel` is a lattice-monotone update:

- `callersHigh` sets `high` only `if (level !== 'blocking')` — i.e.
  $\mathrm{level} \leftarrow \max(\mathrm{level}, \textsf{high})$;
- `callersWarn` and `apiSurface` set `moderate` only `if (level === 'low')` — i.e.
  $\max(\cdot, \textsf{moderate})$;
- `crossRepo` sets `high` unless already `blocking` — i.e. $\max(\cdot, \textsf{high})$;
- the external+surface rule assigns `blocking` unconditionally — the top element,
  which any $\max$ preserves.

Hence no rule can demote a level, and the observable result equals the join. The
reasons array (`lib/rules.js:126,131,134,139,144,149`) is the human-readable
witness set of which contributions fired.

---

## 7. Content fingerprint and the gate predicate

### 7.1 Fingerprint

For a file $f$ with current content $\mathrm{content}(f)$, the fingerprint is the
SHA-1 of its UTF-8 bytes (`hashContent`, `lib/analyze.js:26-28`):

$$
h(f) \;=\; \mathrm{SHA\text{-}1}\bigl(\mathrm{content}(f)\bigr).
$$

At analysis time, `run` records $h(f)$ for every file the gate may later consider
"covered" — the union of changed files, declaration files, caller files, and
coupled files (`coveredForHash`, `lib/analyze.js:257-267`) — into the
`fileHashes` map $H$ persisted in `.impact/latest.json`.

### 7.2 The freshness / admissibility predicate

The PreToolUse gate (`bin/impact.js:80-152`, driven by `hooks/impact-gate.js`)
admits an edit to file $f$ iff **all** of the following hold. Let $\mathrm{rel}$
be $f$'s repo-relative path, $t_{\mathrm{gen}}$ the report's `generatedAt`
timestamp, and

$$
\mathrm{Scope} \;=\; \mathrm{changedFiles} \,\cup\, \{\mathrm{declFile}(s)\}_s \,\cup\, \{\text{topCallers}\} \,\cup\, \{\text{coupling files}\}
\qquad(\text{`bin/impact.js:111-116`}).
$$

$$
\mathrm{Pass}(f) \;\equiv\;
\underbrace{\exists\,\texttt{latest.json}}_{\text{`:91`}}
\ \wedge\
\underbrace{\frac{\mathrm{now} - t_{\mathrm{gen}}}{60\,\mathrm{s}} \le T_{\max}}_{\text{age gate, `:103-104`}}
\ \wedge\
\underbrace{\mathrm{rel} \in \mathrm{Scope}}_{\text{`:117`}}
\ \wedge\
\underbrace{H[\mathrm{rel}] \ \text{exists}}_{\text{`:133`}}
\ \wedge\
\underbrace{h(f) = H[\mathrm{rel}]}_{\text{`:139`}}
\ \wedge\
\underbrace{\mathrm{risk} \neq \textsf{blocking}}_{\text{`:145`}}.
$$

If any conjunct fails, `gate` exits non-zero and the hook converts that into a
Claude Code exit-2 block (`hooks/impact-gate.js:64-81`). The hash conjunct is the
anti-staleness guard: a report may be fresh in time yet describe an *earlier*
version of $f$ — comparing $h(f)$ against the recorded $H[\mathrm{rel}]$ closes
that hole (`bin/impact.js:122-142`). The $\mathrm{risk} \neq \textsf{blocking}$
conjunct is what turns a $\textsf{blocking}$ level (Section 6) into an actual
hard stop requiring human validation. See `06-risk-model.md`.

---

## 8. What is NOT modeled

seismo-cc is an in-degree / co-change heuristic, not a graph-theoretic
analyzer. The following classical constructs are **deliberately absent** — no
code computes them, and no formula above depends on them:

- **Transitive reachability.** $E_{\mathrm{ref}}$ is one-hop only (Section 2.3).
  There is no transitive closure $E_{\mathrm{ref}}^{+}$, so indirect callers
  (callers of callers) are never counted.
- **Shortest-path / dependency depth.** No BFS/DFS distance, no notion of "how
  many hops away" a consumer is.
- **Fan-out / out-degree.** Only fan-in (in-degree) is computed; the number of
  symbols a file *depends on* is not measured.
- **Centrality.** No betweenness, closeness, eigenvector, or PageRank-style
  centrality — importance is proxied crudely by raw fan-in and co-change ratio.
- **Edge-weighted propagation.** Risk does not diffuse along edges; there is no
  weighted flow, no impact-propagation kernel. Coupling ratios rank candidates
  but are never composed across chains.
- **Type-accurate resolution.** Reference matching is textual (name + boundary +
  noise-stripping), so homonyms and dynamic dispatch are approximated by the
  confidence tiers of Section 3, not resolved.

These omissions are intentional trade-offs for the "works on any repo without a
build" goal, and their validity envelope — where the heuristic is trustworthy and
where it is not — is analyzed in `09-limitations-and-validity.md`.

---

## 9. Cross-references

- **`02-scientific-concepts.md`** — the intuitions behind co-change and
  name-based reference analysis; provenance of the association-rule framing.
- **`04-algorithms-and-complexity.md`** — the algorithms that evaluate these
  formulas and their time/space complexity (scan caching, `commitIndex`
  memoization, walk bounds).
- **`06-risk-model.md`** — narrative treatment of the risk lattice, threshold
  calibration, and the gate's decision policy.
- **`07-git-historical-coupling.md`** — deep dive on Section 4: window choice,
  merge handling, and the statistical caveats of $r(A \to B)$.
- **`09-limitations-and-validity.md`** — the formal validity envelope and the
  consequences of everything listed in Section 8.
