#!/usr/bin/env node
'use strict';
/**
 * Empirical validation of the co-change coupling predictor (ROADMAP P2).
 *
 * Replays a repo's history as transactions and measures how well the coupling
 * model predicts the rest of a commit from one seed file, using PRIOR history
 * only (temporal, leakage-free). Prints a precision/recall/F1 sweep over the
 * thresholds `couplingMinCommits` × `couplingMinRatio`, so you can pick the
 * setting that fits the repo and put it in impact.config.json.
 *
 *   node test/validate.js ~/repos/my-service
 *   node test/validate.js ~/repos/my-service --window 800
 *   node test/validate.js ~/repos --window 600 --json
 *
 * Read-only. Nothing in the analyzed repo is modified.
 *
 * What this does and does NOT measure: it validates the historical-coupling
 * signal — the language-agnostic core. It does not score the static fan-in
 * signal (that needs a resolved-symbol oracle, ROADMAP P4). Recall is a
 * conservative lower bound (a file that never co-changed before is unpredictable
 * by any co-change model). See lib/validate.js for the full method and caveats.
 */
const fs = require('fs');
const path = require('path');
const git = require('../lib/git');
const { evaluateCoupling } = require('../lib/validate');

const argv = process.argv.slice(2);
const target = argv.find(a => !a.startsWith('--'));
const asJson = argv.includes('--json');
const wi = argv.indexOf('--window');
const WINDOW = wi !== -1 ? (parseInt(argv[wi + 1], 10) || 600) : 600;

if (!target) {
  console.error('usage: node test/validate.js <repo-or-workspace-dir> [--window N] [--json]');
  process.exit(1);
}

const root = path.resolve(target.replace(/^~/, process.env.HOME || '~'));
const isRepo = dir => fs.existsSync(path.join(dir, '.git'));
const repos = isRepo(root)
  ? [root]
  : fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && isRepo(path.join(root, e.name)))
      .map(e => path.join(root, e.name));

if (!repos.length) {
  console.error(`no git repo found in ${root}`);
  process.exit(1);
}

const pct = x => `${(x * 100).toFixed(1)}%`;
const results = [];

for (const repo of repos) {
  const name = path.basename(repo);
  const commits = git.commitIndex(repo, WINDOW);
  if (commits.length < 60) {
    console.error(`  ${name}: only ${commits.length} commits in the window — too little history to validate, skipped`);
    continue;
  }
  const res = evaluateCoupling(commits, { minPriorCommits: 30, maxCommitFiles: 25 });
  results.push({ repo: name, ...res });

  if (asJson) continue;

  console.log('');
  console.log(`Repo ${name} — coupling predictor, ${commits.length} commits (window ${WINDOW})`);
  console.log('');
  console.log(
    'minCommits'.padStart(11) + 'minRatio'.padStart(10) +
    'precision'.padStart(11) + 'recall'.padStart(9) + 'F1'.padStart(8) +
    'queries'.padStart(9) + 'preds'.padStart(8)
  );
  console.log('─'.repeat(66));
  for (const g of res.grid) {
    const isBest = res.best && g.minCommits === res.best.minCommits && g.minRatio === res.best.minRatio;
    console.log(
      String(g.minCommits).padStart(11) +
      g.minRatio.toFixed(2).padStart(10) +
      pct(g.precision).padStart(11) +
      pct(g.recall).padStart(9) +
      g.f1.toFixed(2).padStart(8) +
      String(g.queries).padStart(9) +
      String(g.predsMade).padStart(8) +
      (isBest ? '   <- best F1' : '')
    );
  }

  if (res.best) {
    const b = res.best;
    console.log('');
    console.log('Interpretation');
    console.log('');
    console.log(`  Best F1 = ${b.f1.toFixed(2)} at couplingMinCommits=${b.minCommits}, couplingMinRatio=${b.minRatio}`);
    console.log(`  (precision ${pct(b.precision)}, recall ${pct(b.recall)} over ${b.queries} queries).`);
    console.log('  Put these in this repo\'s impact.config.json "thresholds" if they beat the defaults');
    console.log('  (couplingMinCommits=3, couplingMinRatio=0.4).');
    if (b.precision < 0.3) {
      console.log('  Low precision: the co-change signal is weak on this repo (few stable pairings,');
      console.log('  or very broad commits). Raise couplingMinRatio to cut noise, and lean more on');
      console.log('  the static and rule signals here.');
    }
    console.log('');
    console.log('  Reminder: recall is a lower bound (first-time pairings are unpredictable by');
    console.log('  co-change), and this measures the coupling signal only — not the static fan-in.');
  } else {
    console.log('\n  No prediction was ever emitted in the window — history too sparse to validate.');
  }
}

if (asJson) console.log(JSON.stringify(results, null, 2));
