#!/usr/bin/env node
'use strict';
/**
 * Vérifie qu'aucun fichier du plugin ne manque. À lancer en premier après une
 * installation ou une copie manuelle : un module absent produit une erreur
 * `Cannot find module` peu bavarde, alors que le diagnostic est trivial.
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
    console.log(`  MANQUE   ${rel}`);
    missing++;
    continue;
  }
  if (rel.endsWith('.json')) {
    try { JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.log(`  JSON KO  ${rel} — ${e.message}`); broken++; continue; }
  }
  console.log(`  ok       ${rel}`);
}

// Les require() du CLI sont la source d'erreur la plus fréquente après une
// copie partielle : on les résout réellement plutôt que de tester l'existence.
try {
  require(path.join(ROOT, 'lib', 'config'));
  require(path.join(ROOT, 'lib', 'git'));
  require(path.join(ROOT, 'lib', 'scan'));
  require(path.join(ROOT, 'lib', 'rules'));
  require(path.join(ROOT, 'lib', 'report'));
  console.log('\n  les 5 modules se chargent correctement');
} catch (e) {
  console.log(`\n  CHARGEMENT KO — ${e.message}`);
  broken++;
}

console.log('');
if (missing || broken) {
  console.log(`${missing} fichier(s) manquant(s), ${broken} problème(s) de chargement.`);
  console.log('Récupère l\'archive complète plutôt que les fichiers un par un.');
  process.exit(1);
}
console.log('Installation complète. Lance ensuite ./test/smoke.sh');
