#!/usr/bin/env node
'use strict';
/**
 * seismo-cc — impact analysis before modifying.
 *
 * Zero dependencies, no index, no server: the goal is to be able to drop into
 * any repo without installation.
 *
 *   impact analyze --symbols Checkout,OrderService
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

// The core computation lives in lib/analyze.js, shared with the MCP server.
// The gate reuses the same content hash as the analysis.
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

// CLI transport: delegates the computation to engine.run(), persists the
// artifact, then formats stdout. The core (resolution, coupling, risk) lives in
// lib/analyze.js — shared as-is with the seismo-impact MCP server.
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
    // stdout must stay pure, parsable JSON: the status line goes to stderr,
    // otherwise `impact analyze --json | jq` breaks.
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
 * gate: called by the PreToolUse hook. Checks that a fresh report covers the
 * file the agent wants to modify. Exits with code 1 if the guard must block;
 * the hook translates that into exit 2 for Claude Code.
 */
function gate(args) {
  const root = path.resolve(args.root || process.cwd());
  const cfg = config.load(root);
  const file = args.file && args.file !== true ? args.file : null;
  const p = path.join(root, '.impact', 'latest.json');

  // The message must be copy-pasteable from the working repo, so it needs the
  // plugin path, not a path relative to the tool.
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

    // The file is in scope: does the report still describe ITS current
    // content? Without this check, you could analyze once and then rewrite
    // everything before the report expires to slip through blind. We compare
    // the hashes.
    const hashes = data.fileHashes || {};
    let current = null;
    try {
      current = hashContent(fs.readFileSync(path.resolve(root, file), 'utf8'));
    } catch {
      current = null;
    }
    if (!hashes[rel]) {
      // Report predates content hashing, or the file was not hashed:
      // freshness cannot be guaranteed. We require a re-analysis.
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
 * record: seismo-memory writer. Called OUTSIDE the read-only analysis path —
 * by a human during a post-mortem, a CI job, or the post-merge git hook
 * (hooks/incident-record.js). Two modes:
 *   record --from-reverts        auto: mines recent `git revert` commits
 *   record --file X --kind ...   manual: one specific incident
 * Idempotent (recordMany deduplicates), so it is safe to replay.
 */
function record(args) {
  const root = path.resolve(args.root || process.cwd());
  const cfg = config.load(root);
  if (!cfg.memoryPath) {
    fail('seismo-memory is disabled. Set "memoryPath" in impact.config.json to enable incident recording.');
    return;
  }

  if (args['from-reverts']) {
    if (!git.isRepo(root)) { fail('not a git repository — --from-reverts needs git history.'); return; }
    const depth = Number(args.depth) > 0 ? Number(args.depth) : 200;
    const { added, reverts } = engine.recordFromReverts(cfg, root, depth);
    process.stdout.write(`recorded ${added} new incident(s) from ${reverts} revert commit(s)\n`);
    return;
  }

  // Manual mode: an explicit incident.
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
  record --from-reverts          mine git reverts into seismo-memory (advisory)
  record --file a.cs --ref TICKET-1 record one incident manually

Options: --root <dir> --workspace <dir> --json --short
         record: --symbol --file --kind --ref --at --from-reverts --depth
`);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
}
