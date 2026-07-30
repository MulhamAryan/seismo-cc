'use strict';
/**
 * Empirical validation of the co-change coupling predictor (P2 in docs/ROADMAP.md).
 *
 * The method is the standard transaction-based evaluation from the Mining
 * Software Repositories literature (Zimmermann et al.). Each commit is a
 * transaction: a set of files that changed together. We hide a commit's files,
 * pick one as the query "seed", predict the rest with the coupling model built
 * from PRIOR history only, and compare the prediction to what actually changed
 * in that commit.
 *
 * Two properties make this a legitimate oracle rather than a circular one:
 *  - **Temporal, leakage-free.** For an evaluation commit, the predictor sees
 *    only commits that happened before it (`commits.slice(i+1)`, since the log is
 *    newest-first). The commit being scored is never in its own training set.
 *  - **Independent ground truth.** The "answer" is what the developer actually
 *    committed together, not another run of the same model.
 *
 * Honest caveats, stated so nothing overclaims:
 *  - This validates the **coupling** signal only — the language-agnostic core.
 *    The static fan-in (reference) signal needs a resolved-symbol oracle to score
 *    (see ROADMAP P4); it is not measured here.
 *  - **Recall is a conservative lower bound.** A file that never co-changed with
 *    the seed in prior history cannot be predicted by any co-change model, yet it
 *    still counts against recall. Co-change is not meant to catch first-time
 *    pairings; it catches the stable, repeated ones.
 *  - Mega-commits (mass rename / reformat) are excluded (`maxCommitFiles`): they
 *    are not logical transactions and would dominate the counts.
 */
const { couplingFrom } = require('./git');

function f1(p, r) {
  return (p + r) ? (2 * p * r) / (p + r) : 0;
}

/**
 * Evaluate one (minCommits, minRatio) setting over a newest-first commit list.
 * Micro-averaged: true/false positives and false negatives are summed across all
 * (commit, seed) queries, then precision/recall are computed once.
 */
function evaluateAt(commits, minCommits, minRatio, opts = {}) {
  const { maxCommitFiles = 25, minPriorCommits = 30 } = opts;
  let tp = 0, fp = 0, fn = 0, queries = 0, predsMade = 0, evalCommits = 0;
  for (let i = 0; i < commits.length; i++) {
    const files = commits[i].files;
    if (files.length < 2 || files.length > maxCommitFiles) continue;
    const prior = commits.slice(i + 1);              // strictly older = no leakage
    if (prior.length < minPriorCommits) continue;
    evalCommits++;
    for (const seed of files) {
      // The seed must itself have enough prior history to be a usable query.
      let seedTouch = 0;
      for (const c of prior) if (c.files.includes(seed)) seedTouch++;
      if (seedTouch < minCommits) continue;
      queries++;
      const predicted = new Set(couplingFrom(prior, [seed], { minCommits, minRatio }).map(e => e.file));
      if (predicted.size) predsMade++;
      const actual = new Set(files.filter(f => f !== seed));
      for (const p of predicted) (actual.has(p) ? (tp++) : (fp++));
      for (const a of actual) if (!predicted.has(a)) fn++;
    }
  }
  const precision = (tp + fp) ? tp / (tp + fp) : 0;
  const recall = (tp + fn) ? tp / (tp + fn) : 0;
  return { minCommits, minRatio, tp, fp, fn, precision, recall, f1: f1(precision, recall), queries, predsMade, evalCommits };
}

/**
 * Sweep a grid of thresholds and return every cell plus the best by F1.
 * `commits` is newest-first, as produced by git.commitIndex.
 */
function evaluateCoupling(commits, opts = {}) {
  const minCommitsList = opts.minCommitsList || [2, 3, 4];
  const minRatioList = opts.minRatioList || [0.3, 0.4, 0.5, 0.6];
  const grid = [];
  for (const mc of minCommitsList)
    for (const mr of minRatioList)
      grid.push(evaluateAt(commits, mc, mr, opts));
  const scored = grid.filter(g => (g.tp + g.fp) > 0);
  const best = scored.slice().sort((a, b) => b.f1 - a.f1 || b.tp - a.tp)[0] || null;
  return {
    grid,
    best,
    windowCommits: commits.length,
    meta: { maxCommitFiles: opts.maxCommitFiles || 25, minPriorCommits: opts.minPriorCommits || 30 },
  };
}

module.exports = { evaluateCoupling, evaluateAt, f1 };
