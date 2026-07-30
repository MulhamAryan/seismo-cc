#!/usr/bin/env node
'use strict';
/**
 * seismo-cc — analyse d'impact avant modification.
 *
 * Zéro dépendance, aucun index, aucun serveur : le but est de pouvoir tomber
 * dans n'importe quel repo sans installation.
 *
 *   impact analyze --symbols DispenseOrder,OrderService
 *   impact analyze --files src/Foo.cs
 *   impact analyze --diff --base main
 *   impact gate --file src/Foo.cs
 */
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const report = require('../lib/report');
const engine = require('../lib/analyze');
const git = require('../lib/git');
const memory = require('../lib/memory');

// Le coeur du calcul vit dans lib/analyze.js, partagé avec le serveur MCP.
// Le gate réutilise la même empreinte de contenu que l'analyse.
const { hashContent } = engine;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

// Transport CLI : délègue le calcul à engine.run(), persiste l'artefact, puis
// formate stdout. Le coeur (résolution, couplage, risque) vit dans
// lib/analyze.js — partagé tel quel avec le serveur MCP eonix-impact.
function analyze(args) {
  const data = engine.run({
    root: args.root,
    symbols: args.symbols,
    files: args.files,
    diff: args.diff,
    base: args.base,
    workspace: args.workspace,
  });
  const md = engine.persist(data.root, data);

  const statusLine = `(report written to .impact/report.md — ${data.filesScanned} files scanned)`;
  if (args.json) {
    // stdout doit rester du JSON pur et parsable : la ligne de statut part sur
    // stderr, sinon `impact analyze --json | jq` casse.
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    process.stderr.write(statusLine + '\n');
  } else if (args.short) {
    process.stdout.write(report.renderShort(data) + '\n');
    process.stdout.write(`\n${statusLine}\n`);
  } else {
    process.stdout.write(md);
    process.stdout.write(`\n${statusLine}\n`);
  }
  return data;
}

// ---------------------------------------------------------------------------

/**
 * gate : appelé par le hook PreToolUse. Vérifie qu'un rapport frais couvre
 * le fichier que l'agent veut modifier. Sort en code 1 si le garde-fou doit
 * bloquer ; le hook traduit ça en exit 2 pour Claude Code.
 */
function gate(args) {
  const root = path.resolve(args.root || process.cwd());
  const cfg = config.load(root);
  const file = args.file && args.file !== true ? args.file : null;
  const p = path.join(root, '.impact', 'latest.json');

  // Le message doit être copiable-collable depuis le repo de travail, donc il
  // faut le chemin du plugin, pas un chemin relatif à l'outil.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  const cmd = f => `node "${pluginRoot}/bin/impact.js" analyze --files ${f} --short`;

  if (!fs.existsSync(p)) {
    fail(`No impact analysis for this repo.\nRun: ${cmd(file || '<file>')}`);
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    fail('Impact report unreadable. Re-run the analysis.');
    return;
  }

  const ageMin = (Date.now() - new Date(data.generatedAt).getTime()) / 60000;
  if (ageMin > cfg.thresholds.reportMaxAgeMinutes) {
    fail(`Impact report is ${Math.round(ageMin)} min old (limit ${cfg.thresholds.reportMaxAgeMinutes}). Re-run the analysis.`);
    return;
  }

  if (file) {
    const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    const covered = new Set([
      ...(data.changedFiles || []),
      ...(data.symbols || []).map(s => s.declFile).filter(Boolean),
      ...(data.topCallers || []).map(c => c.file),
      ...(data.coupling || []).map(c => c.file),
    ]);
    if (!covered.has(rel)) {
      fail(`\`${rel}\` is not in the analyzed scope.\nRun: ${cmd(rel)}`);
      return;
    }

    // Le fichier est dans le périmètre : le rapport décrit-il encore SON
    // contenu actuel ? Sans cette vérification, il suffit d'analyser une fois
    // puis de tout réécrire avant l'expiration du rapport pour passer à
    // l'aveugle. On compare les empreintes.
    const hashes = data.fileHashes || {};
    let current = null;
    try {
      current = hashContent(fs.readFileSync(path.resolve(root, file), 'utf8'));
    } catch {
      current = null;
    }
    if (!hashes[rel]) {
      // Rapport antérieur à l'empreinte de contenu, ou fichier non empreinté :
      // impossible de garantir la fraîcheur. On exige une réanalyse.
      fail(`\`${rel}\` is covered but has no content hash in the report.\nRun: ${cmd(rel)}`);
      return;
    }
    if (current !== hashes[rel]) {
      fail(`\`${rel}\` has changed since the analysis (content differs from the report).\nRun: ${cmd(rel)}`);
      return;
    }
  }

  if (data.risk.level === 'blocking') {
    fail(`BLOCKING risk: ${data.risk.reasons.join('; ')}\nHuman validation required before modifying. See .impact/report.md`);
    return;
  }

  process.stdout.write(`impact ok — risk ${data.risk.level} (${Math.round(ageMin)} min)\n`);
  process.exit(0);
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------

/**
 * record : écrivain d'eonix-memory. Appelé HORS du chemin d'analyse read-only
 * — par un humain en post-mortem, un job CI, ou le git hook post-merge
 * (hooks/incident-record.js). Deux modes :
 *   record --from-reverts        auto : mine les commits `git revert` récents
 *   record --file X --kind ...   manuel : un incident précis
 * Idempotent (recordMany dédoublonne), donc rejouable sans risque.
 */
function record(args) {
  const root = path.resolve(args.root || process.cwd());
  const cfg = config.load(root);
  if (!cfg.memoryPath) {
    fail('eonix-memory is disabled. Set "memoryPath" in impact.config.json to enable incident recording.');
    return;
  }

  if (args['from-reverts']) {
    if (!git.isRepo(root)) { fail('not a git repository — --from-reverts needs git history.'); return; }
    const depth = Number(args.depth) > 0 ? Number(args.depth) : 200;
    const { added, reverts } = engine.recordFromReverts(cfg, root, depth);
    process.stdout.write(`recorded ${added} new incident(s) from ${reverts} revert commit(s)\n`);
    return;
  }

  // Mode manuel : un incident explicite.
  const inc = {};
  if (args.symbol && args.symbol !== true) inc.symbol = args.symbol;
  if (args.file && args.file !== true) inc.file = args.file;
  if (!inc.symbol && !inc.file) {
    fail('record needs --symbol or --file (or --from-reverts).');
    return;
  }
  inc.kind = (args.kind && args.kind !== true) ? args.kind : 'incident';
  if (args.ref && args.ref !== true) inc.ref = args.ref;
  inc.at = (args.at && args.at !== true) ? args.at : new Date().toISOString().slice(0, 10);
  const added = memory.recordMany(cfg, root, [inc]);
  process.stdout.write(added ? `recorded incident: ${memory.incidentKey(inc).trim()}\n` : 'already recorded (no change)\n');
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
  if (cmd === 'analyze') analyze(args);
  else if (cmd === 'gate') gate(args);
  else if (cmd === 'record') record(args);
  else {
    process.stdout.write(`seismo-cc — impact analysis before modifying

  analyze --symbols A,B          scope of one or more symbols
  analyze --files a.cs,b.php     scope inferred from the file's declarations
  analyze --diff --base main     analysis of the current diff
  gate --file a.cs               guard: does a fresh report cover this file?
  record --from-reverts          mine git reverts into eonix-memory (advisory)
  record --file a.cs --ref MIL-1 record one incident manually

Options: --root <dir> --workspace <dir> --json --short
         record: --symbol --file --kind --ref --at --from-reverts --depth
`);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
}
