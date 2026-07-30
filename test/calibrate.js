#!/usr/bin/env node
'use strict';
/**
 * Calibration. Replays the last N commits of each repo and measures which risk
 * level the tool would have reported.
 *
 * This is the measurement that decides whether the tool is deployable. A guard
 * that turns BLOCKING on one commit in three will be disabled by the team
 * before the end of the month — and the problem will then be the threshold,
 * not the parser.
 *
 *   node test/calibrate.js ~/repos              # all repos in the folder
 *   node test/calibrate.js ~/repos --commits 60
 *   node test/calibrate.js ~/repos/my-service --commits 100
 *
 * Read-only: no file of the analyzed repo is modified, except .impact/ which is
 * cleaned up at the end.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PLUGIN_ROOT, 'bin', 'impact.js');

const argv = process.argv.slice(2);
const target = argv.find(a => !a.startsWith('--'));
const commitsFlag = argv.indexOf('--commits');
const N = commitsFlag !== -1 ? parseInt(argv[commitsFlag + 1], 10) || 40 : 40;

if (!target) {
  console.error('usage: node test/calibrate.js <repo-or-workspace-dir> [--commits N]');
  process.exit(1);
}

const root = path.resolve(target.replace(/^~/, process.env.HOME || '~'));

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32e6 });
  } catch { return ''; }
}

function isRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

const repos = isRepo(root)
  ? [root]
  : fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && isRepo(path.join(root, e.name)))
      .map(e => path.join(root, e.name));

if (!repos.length) {
  console.error(`no git repo found in ${root}`);
  process.exit(1);
}

const LEVELS = ['low', 'moderate', 'high', 'blocking'];
const global = { low: 0, moderate: 0, high: 0, blocking: 0, errors: 0, durations: [] };
const rows = [];
const blockingSamples = [];

for (const repo of repos) {
  const name = path.basename(repo);
  const shas = git(repo, ['log', `-n${N}`, '--format=%H', '--no-merges']).split('\n').filter(Boolean);
  if (!shas.length) { console.error(`  ${name}: no commit, skipped`); continue; }

  const tally = { low: 0, moderate: 0, high: 0, blocking: 0, errors: 0 };
  const durations = [];

  for (const sha of shas) {
    // The commit's files as they exist today. Assumed approximation: no
    // checkout, we measure how the rules fire on realistic file sets.
    const files = git(repo, ['show', '--name-only', '--format=', sha])
      .split('\n').map(s => s.trim()).filter(Boolean)
      .filter(f => fs.existsSync(path.join(repo, f)));
    if (!files.length) continue;

    const t0 = Date.now();
    let out;
    try {
      out = execFileSync(process.execPath, [CLI, 'analyze', '--root', repo, '--files', files.slice(0, 40).join(','), '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, timeout: 120000 });
    } catch (e) {
      tally.errors++; global.errors++;
      continue;
    }
    durations.push(Date.now() - t0);

    let data;
    try { data = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); }
    catch { tally.errors++; global.errors++; continue; }

    const lvl = data.risk && data.risk.level;
    if (!LEVELS.includes(lvl)) { tally.errors++; global.errors++; continue; }
    tally[lvl]++; global[lvl]++;

    if (lvl === 'blocking' && blockingSamples.length < 12) {
      blockingSamples.push({
        repo: name,
        sha: sha.slice(0, 8),
        subject: git(repo, ['log', '-1', '--format=%s', sha]).trim().slice(0, 60),
        reasons: data.risk.reasons.join('; '),
      });
    }
  }

  global.durations.push(...durations);
  const total = LEVELS.reduce((a, l) => a + tally[l], 0);
  rows.push({ name, total, ...tally, p50: median(durations) });

  // Cleanup: calibration must leave nothing behind.
  fs.rmSync(path.join(repo, '.impact'), { recursive: true, force: true });
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function pct(n, total) {
  return total ? `${Math.round((n / total) * 100)}%` : '—';
}

// ---------------------------------------------------------------- reporting
const W = 22;
console.log('');
console.log('Calibration — risk-level distribution over real history');
console.log('');
console.log(
  'repo'.padEnd(W) + 'commits'.padStart(9) + 'low'.padStart(9) +
  'moderate'.padStart(10) + 'high'.padStart(9) + 'blocking'.padStart(10) + 'p50 ms'.padStart(9)
);
console.log('─'.repeat(W + 56));
for (const r of rows) {
  console.log(
    r.name.slice(0, W - 1).padEnd(W) +
    String(r.total).padStart(9) +
    pct(r.low, r.total).padStart(9) +
    pct(r.moderate, r.total).padStart(10) +
    pct(r.high, r.total).padStart(9) +
    pct(r.blocking, r.total).padStart(10) +
    String(r.p50).padStart(9)
  );
}

const T = LEVELS.reduce((a, l) => a + global[l], 0);
console.log('─'.repeat(W + 56));
console.log(
  'TOTAL'.padEnd(W) + String(T).padStart(9) +
  pct(global.low, T).padStart(9) + pct(global.moderate, T).padStart(10) +
  pct(global.high, T).padStart(9) + pct(global.blocking, T).padStart(10) +
  String(median(global.durations)).padStart(9)
);
if (global.errors) console.log(`\n${global.errors} analysis error(s) (skipped).`);

if (blockingSamples.length) {
  console.log('\nSample of commits that turned BLOCKING — review one by one:\n');
  for (const s of blockingSamples) {
    console.log(`  ${s.repo} ${s.sha}  ${s.subject}`);
    console.log(`      ${s.reasons}`);
  }
}

// ------------------------------------------------------------------ verdict
const rateBlocking = T ? global.blocking / T : 0;
const rateHighPlus = T ? (global.blocking + global.high) / T : 0;

console.log('\nInterpretation\n');
if (rateBlocking > 0.15) {
  console.log(`  BLOCKING on ${pct(global.blocking, T)} of commits: too high.`);
  console.log('  Re-read the sample above. If these commits were genuinely safe,');
  console.log('  the problem is in the rules, not the code: remove or lower the weight');
  console.log('  of overly broad patterns in lib/config.js (auth and external-call are the');
  console.log('  first suspects), or declare the affected paths in "ignore".');
} else if (rateBlocking < 0.01 && T > 50) {
  console.log(`  BLOCKING on ${pct(global.blocking, T)} of commits: possibly too permissive.`);
  console.log('  Check that this repo\'s migrations and payment paths are actually');
  console.log('  recognized by the patterns in lib/config.js.');
} else {
  console.log(`  BLOCKING on ${pct(global.blocking, T)} of commits: workable range.`);
}
console.log(`  HIGH or above on ${pct(global.blocking + global.high, T)} of commits.`);
if (rateHighPlus > 0.4) {
  console.log('  Beyond 40%, the agent will ask for human arbitration too often and');
  console.log('  the team will stop reading the reports. Raise callersWarn and callersHigh.');
}
console.log(`  Median latency: ${median(global.durations)} ms. Beyond ~2000 ms, the hook becomes noticeable.`);
console.log('\n  Thresholds are tuned per repo in impact.config.json, not globally:');
console.log('  a 293-entity monolith and a microservice do not share the same profile.\n');
