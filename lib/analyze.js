'use strict';
/**
 * Core of the impact analysis, extracted from bin/impact.js so it can be shared
 * across transports: the CLI (bin/impact.js) AND the seismo-impact MCP server
 * both call the SAME `run()` then `persist()`. A single computation path, a
 * single `.impact/latest.json` artifact — that's what guarantees the PreToolUse
 * gate always sees the report the analysis just wrote, whatever its source.
 *
 * `run(opts)` performs NO writes and no stdout output: it returns `data`.
 * `persist(root, data)` materializes report.md + latest.json. The stdout
 * formatting (json/short/md) stays the CLI's concern.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const git = require('./git');
const scan = require('./scan');
const rules = require('./rules');
const report = require('./report');
const memory = require('./memory');
const hidden = require('./hidden');

// Fingerprint of a file's content. The gate compares the fingerprint recorded
// at analysis time with the current one: if they differ, the report no longer
// describes the file we're about to modify — it must be re-analyzed.
function hashContent(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// Normalizes an input into a list: accepts an array (MCP call), a comma-
// separated string (CLI legacy), or nothing. The core thus stays agnostic to
// the transport.
function toList(v) {
  if (!v || v === true) return [];
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Searches for symbols in sibling repos. A naive and deliberately capped
 * approach: it's an alert signal, not a cross-repo graph. v2 will replace this
 * with a shared index.
 */
function scanWorkspace(cfg, symbolNames, selfRoot) {
  const ws = path.resolve(cfg.workspace.replace(/^~/, process.env.HOME || '~'));
  let entries;
  try {
    entries = fs.readdirSync(ws, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const repoRoot = path.join(ws, e.name);
    if (path.resolve(repoRoot) === path.resolve(selfRoot)) continue;
    if (!fs.existsSync(path.join(repoRoot, '.git'))) continue;
    const sub = config.load(repoRoot);
    const files = scan.walk(repoRoot, sub, 8000);
    for (const name of symbolNames) {
      const hits = scan.references(repoRoot, files, name, null);
      if (hits.length) out.push({ repo: e.name, symbol: name, files: hits.length, sample: hits[0].file });
    }
  }
  return out;
}

// Coarse key for a surface sample: the last identifier in the matched text
// (~ route/member name). Used to pair a removal and an addition as the SAME
// symbol whose signature changed, rather than two separate events.
function apiKey(sample) {
  const ids = sample.match(/[A-Za-z_]\w*/g);
  return ids && ids.length ? ids[ids.length - 1] : sample;
}

/**
 * Before/after diff of the public surface over the changed files. "Before" =
 * version at the common ancestor (git show mergeBase:file), "after" = current
 * version. Returns ONLY what breaks an existing consumer: public elements that
 * are removed (`removed`) or whose signature changes (`changed`). Additions
 * break no one — excluded from breaking changes (by contract).
 */
function computeApiBreaking(root, base, changedFiles) {
  const mb = git.mergeBase(root, base);
  if (!mb) return [];
  const out = [];
  for (const rel of changedFiles) {
    const newRaw = scan.read(root, rel);
    const oldRaw = git.showFile(root, mb, rel);
    if (newRaw === null && oldRaw === null) continue;
    // RAW content, not stripNoise: the route string (`"checkout"`) IS the
    // identity of an endpoint. Blanking it would merge two distinct routes and
    // hide a rename. The API_SURFACE regexes are specific enough that a match
    // inside a comment stays rare and inconsequential (signal, not proof).
    const newF = newRaw !== null ? rules.apiSurfaceOfContent(newRaw, rel) : [];
    const oldF = oldRaw !== null ? rules.apiSurfaceOfContent(oldRaw, rel) : [];

    // Group the samples by rule (id): we only compare the same kind of surface
    // (endpoint vs endpoint, not endpoint vs migration).
    const byId = new Map();
    const bucket = id => {
      let e = byId.get(id);
      if (!e) { e = { label: null, oldS: new Set(), newS: new Set() }; byId.set(id, e); }
      return e;
    };
    for (const f of oldF) { const e = bucket(f.id); e.label = f.label; f.samples.forEach(s => e.oldS.add(s)); }
    for (const f of newF) { const e = bucket(f.id); e.label = f.label; f.samples.forEach(s => e.newS.add(s)); }

    for (const [id, e] of byId) {
      const removed = [...e.oldS].filter(s => !e.newS.has(s));
      const added = [...e.newS].filter(s => !e.oldS.has(s));
      const addedByKey = new Map(added.map(s => [apiKey(s), s]));
      for (const s of removed) {
        const k = apiKey(s);
        if (addedByKey.has(k)) {
          out.push({ file: rel, id, label: e.label, symbol: k, change: 'changed', before: s, after: addedByKey.get(k) });
          addedByKey.delete(k);
        } else {
          out.push({ file: rel, id, label: e.label, symbol: k, change: 'removed', before: s });
        }
      }
    }
  }
  return out;
}

/**
 * Computes the impact analysis and returns `data`. No side effects.
 * opts = { root, symbols, files, diff, base, workspace }
 *   symbols/files: array OR comma-separated string.
 */
function run(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const cfg = config.load(root);
  if (opts.workspace) cfg.workspace = opts.workspace;

  const files = scan.walk(root, cfg);
  const mode = opts.diff ? 'diff' : 'plan';
  const base = opts.base && opts.base !== true ? opts.base : (opts.diff ? 'origin/main' : null);

  // 1. Determine the input scope: explicit symbols, files, or diff.
  let targetFiles = toList(opts.files);
  let symbolNames = toList(opts.symbols);

  if (mode === 'diff') {
    targetFiles = [...new Set([...targetFiles, ...git.changedFiles(root, base)])];
  }
  targetFiles = scan.filterPaths(targetFiles, cfg);

  // If we have files but no symbols, we extract the declarations to know what
  // to search for.
  if (!symbolNames.length && targetFiles.length) {
    const decls = [];
    for (const rel of targetFiles) {
      const content = scan.read(root, rel);
      if (content === null) continue;
      decls.push(...scan.declarations(rel, content));
    }
    // Types first: a property name like `Status` mostly generates noise. We
    // only descend to members if there's room left.
    const types = [...new Set(decls.filter(d => d.kind === 'type').map(d => d.name))];
    // If the types already cover the scope, adding their members brings only
    // noise: the callers of the type include the callers of the members.
    const members = types.length >= 3 ? [] :
      [...new Set(decls.filter(d => d.kind !== 'type').map(d => d.name))]
        .filter(n => n.length >= 6).slice(0, 6);
    symbolNames = [...types, ...members].slice(0, 12);
  }

  // 2. Locate each symbol and find its references.
  const symbols = [];
  const refsBySymbol = {};
  const allCallers = [];

  for (const name of symbolNames) {
    // We collect ALL the declarations, not just the first. A name-based search
    // merges two `Order`s from different namespaces; the least we can do is
    // detect it and say so, rather than present a falsely precise scope.
    // (.NET focus: C# namespaces make name clashes frequent.)
    const declSites = [];
    for (const rel of files) {
      const content = scan.read(root, rel);
      if (content === null || !content.includes(name)) continue;
      const decls = scan.declarationsCached(rel, content).filter(d => d.name === name);
      for (const d of decls) {
        declSites.push({ file: rel, line: d.line, kind: d.kind, namespace: scan.namespaceAt(content, d.line) });
      }
    }
    const declFile = declSites.length ? declSites[0].file : null;
    const declLine = declSites.length ? declSites[0].line : null;
    const kind = declSites.length ? declSites[0].kind : null;
    const namespaces = [...new Set(declSites.map(d => d.namespace).filter(Boolean))];
    const ambiguous = declSites.length > 1;

    const refs = scan.references(root, files, name, declFile, { ambiguous });
    refsBySymbol[name] = refs;
    const external = refs.filter(r => r.file !== declFile);
    symbols.push({
      name, kind, declFile, declLine,
      callSites: external.reduce((a, r) => a + r.count, 0),
      files: external.length,
      declCount: declSites.length,
      ambiguous,
      namespaces,
    });
    for (const r of external) allCallers.push({ ...r, symbol: name });
  }

  // 3. Historical coupling.
  const couplingSeed = [...new Set([
    ...targetFiles,
    ...symbols.map(s => s.declFile).filter(Boolean),
  ])];
  const coupling = git.isRepo(root) && couplingSeed.length
    ? git.coupling(root, couplingSeed, {
        depth: cfg.gitDepth,
        minCommits: cfg.thresholds.couplingMinCommits,
        minRatio: cfg.thresholds.couplingMinRatio,
      })
    : [];

  // 4. Risk rules.
  const inspectFiles = [...new Set([
    ...targetFiles,
    ...symbols.map(s => s.declFile).filter(Boolean),
    ...coupling.slice(0, 15).map(c => c.file),
  ])];
  const diffTxt = mode === 'diff' ? git.diffText(root, base) : null;
  const irr = rules.irreversible(root, inspectFiles, diffTxt);
  // The public surface of the coupled files matters just as much: it's often
  // the endpoint that changes with the domain without being named in the ticket.
  const api = rules.apiSurface(root, inspectFiles);
  // Before/after diff of the public surface: only in diff mode with a base.
  const apiBreaking = (mode === 'diff' && base) ? computeApiBreaking(root, base, targetFiles) : [];
  const tests = rules.affectedTests(cfg, refsBySymbol, coupling);

  // 5. Optional cross-repo: scan the workspace's sibling repos.
  const crossRepo = cfg.workspace ? scanWorkspace(cfg, symbolNames, root) : [];

  const summary = {
    callers: symbols.reduce((a, s) => a + s.callSites, 0),
    apiSurface: api.length,
    crossRepo: new Set(crossRepo.map(r => r.repo)).size,
    externalConsumers: (cfg.externalConsumers || []).length,
    irreversible: irr,
  };
  const risk = rules.riskLevel(cfg, summary);

  // seismo-memory history hints: ADVISORY only. Computed AFTER the risk and
  // never fed back into it — the gate stays deterministic. Empty if memoryPath
  // is not configured (graceful degradation).
  const priorHints = memory.priorHints(memory.load(cfg, root), symbols, targetFiles);

  // Hidden-dependency checks (P1): ADVISORY, same contract as priorHints —
  // computed after the risk and never fed back into it. Cheap lexical scans
  // that surface reflection/DI/SQL/dynamic-route dependencies the reference
  // search cannot see, so the report can report them instead of only listing
  // them as blind spots.
  const hiddenChecks = hidden.check(root, files, symbols, inspectFiles);

  // Fingerprints of all the files the gate will consider "covered". Without
  // them, a report that is fresh but based on an earlier version of the file
  // would let a modification slip through blindly.
  const coveredForHash = new Set([
    ...targetFiles,
    ...symbols.map(s => s.declFile).filter(Boolean),
    ...allCallers.map(c => c.file),
    ...coupling.map(c => c.file),
  ]);
  const fileHashes = {};
  for (const rel of coveredForHash) {
    const c = scan.read(root, rel);
    if (c !== null) fileHashes[rel] = hashContent(c);
  }

  return {
    mode,
    repo: path.basename(root),
    root,
    branch: git.currentBranch(root),
    head: git.head(root),
    base: base || null,
    generatedAt: new Date().toISOString(),
    configFound: cfg.configFound,
    symbols,
    topCallers: allCallers.sort((a, b) => b.count - a.count),
    coupling,
    apiSurface: api,
    apiBreaking,
    irreversible: irr,
    tests,
    priorHints,
    hiddenChecks,
    crossRepo,
    externalConsumers: cfg.externalConsumers || [],
    changedFiles: targetFiles,
    summary,
    risk,
    fileHashes,
    filesScanned: files.length,
  };
}

/**
 * Materializes the report. The hook and the reviewer read these two files.
 * Separated from run() so a caller can compute without writing (test, dry-run)
 * — but any transport that wants to feed the gate MUST call this.
 */
function persist(root, data) {
  const outDir = path.join(root, '.impact');
  fs.mkdirSync(outDir, { recursive: true });
  const md = report.render(data);
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(data, null, 2));
  return md;
}

/**
 * Feeds seismo-memory from recent revert commits. The orchestration
 * (git + scan + memory) is placed here to stay DRY: the CLI command `record
 * --from-reverts` AND the post-merge git hook both call this same function,
 * without duplicating the logic and without polluting memory.js (which stays
 * pure fs/path). Idempotent, non-blocking, a no-op if memoryPath is absent or
 * outside a git repo.
 */
function recordFromReverts(cfg, root, depth = 200) {
  if (!cfg.memoryPath || !git.isRepo(root)) return { added: 0, reverts: 0 };
  const reverts = git.recentReverts(root, depth);
  const incidents = [];
  for (const r of reverts) {
    const ref = `revert:${r.sha.slice(0, 10)}`;
    const at = (r.date || '').slice(0, 10);
    for (const f of scan.filterPaths(r.files, cfg)) {
      incidents.push({ file: f, kind: 'revert', ref, at });
    }
  }
  return { added: memory.recordMany(cfg, root, incidents), reverts: reverts.length };
}

module.exports = { run, persist, hashContent, toList, scanWorkspace, recordFromReverts };
