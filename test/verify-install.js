#!/usr/bin/env node
'use strict';
/**
 * Verifies that no plugin file is missing. Run this first after an
 * installation or a manual copy: a missing module produces an unhelpful
 * `Cannot find module` error, whereas the diagnosis is trivial.
 *
 *   node test/verify-install.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED = [
  '.claude-plugin/plugin.json',
  'agents/impact-analyst.md',
  'skills/impact-analysis/SKILL.md',
  'commands/impact.md',
  'hooks/hooks.json',
  'hooks/impact-gate.js',
  'bin/impact.js',
  'lib/config.js',
  'lib/git.js',
  'lib/scan.js',
  'lib/rules.js',
  'lib/report.js',
  'impact.config.example.json',
  'examples/marketplace.json',
  'README.md',
  'test/fixture.sh',
  'test/smoke.sh',
  'test/calibrate.js',
  'test/README.md',
];

let missing = 0, broken = 0;
for (const rel of REQUIRED) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log(`  MISSING  ${rel}`);
    missing++;
    continue;
  }
  if (rel.endsWith('.json')) {
    try { JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.log(`  JSON KO  ${rel} — ${e.message}`); broken++; continue; }
  }
  console.log(`  ok       ${rel}`);
}

// The CLI's require() calls are the most frequent source of error after a
// partial copy: we actually resolve them rather than testing for existence.
try {
  require(path.join(ROOT, 'lib', 'config'));
  require(path.join(ROOT, 'lib', 'git'));
  require(path.join(ROOT, 'lib', 'scan'));
  require(path.join(ROOT, 'lib', 'rules'));
  require(path.join(ROOT, 'lib', 'report'));
  console.log('\n  all 5 modules load correctly');
} catch (e) {
  console.log(`\n  LOADING FAILED — ${e.message}`);
  broken++;
}

console.log('');
if (missing || broken) {
  console.log(`${missing} missing file(s), ${broken} loading problem(s).`);
  console.log('Grab the complete archive rather than the files one by one.');
  process.exit(1);
}
console.log('Installation complete. Next, run ./test/smoke.sh');
