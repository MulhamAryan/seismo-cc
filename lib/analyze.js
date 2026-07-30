'use strict';
/**
 * Coeur de l'analyse d'impact, extrait de bin/impact.js pour être partagé
 * entre transports : la CLI (bin/impact.js) ET le serveur MCP eonix-impact
 * appellent le MÊME `run()` puis `persist()`. Un seul chemin de calcul, un
 * seul artefact `.impact/latest.json` — c'est ce qui garantit que le gate
 * PreToolUse voit toujours le rapport que l'analyse vient d'écrire, quelle
 * qu'en soit la source.
 *
 * `run(opts)` ne fait AUCUNE écriture ni sortie stdout : il retourne `data`.
 * `persist(root, data)` matérialise report.md + latest.json. Le formatage
 * stdout (json/short/md) reste une affaire de la CLI.
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

// Empreinte du contenu d'un fichier. Le gate compare l'empreinte enregistrée
// à l'analyse avec l'empreinte actuelle : si elles diffèrent, le rapport ne
// décrit plus le fichier qu'on s'apprête à modifier — il faut réanalyser.
function hashContent(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// Normalise une entrée en liste : accepte un tableau (appel MCP), une chaîne
// séparée par des virgules (héritage CLI), ou rien. Le coeur reste donc
// indifférent au transport.
function toList(v) {
  if (!v || v === true) return [];
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Cherche les symboles dans les repos frères. Approche naïve et volontairement
 * plafonnée : c'est un signal d'alerte, pas un graphe inter-repos. La v2
 * remplacera ceci par un index partagé.
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

// Clé grossière d'un échantillon de surface : le dernier identifiant du texte
// matché (~ nom de route/membre). Sert à apparier un retrait et un ajout comme
// un MÊME symbole dont la signature a changé, plutôt que deux évènements.
function apiKey(sample) {
  const ids = sample.match(/[A-Za-z_]\w*/g);
  return ids && ids.length ? ids[ids.length - 1] : sample;
}

/**
 * Diff avant/après de la surface publique sur les fichiers changés. « Avant » =
 * version à l'ancêtre commun (git show mergeBase:file), « après » = version
 * courante. Ne renvoie QUE ce qui casse un consommateur existant : éléments
 * publics retirés (`removed`) ou dont la signature change (`changed`). Les
 * ajouts ne cassent personne — écartés du breaking (contrat).
 */
function computeApiBreaking(root, base, changedFiles) {
  const mb = git.mergeBase(root, base);
  if (!mb) return [];
  const out = [];
  for (const rel of changedFiles) {
    const newRaw = scan.read(root, rel);
    const oldRaw = git.showFile(root, mb, rel);
    if (newRaw === null && oldRaw === null) continue;
    // Contenu BRUT, pas stripNoise : la chaîne de route (`"dispense"`) EST
    // l'identité d'un endpoint. La blanchir fusionnerait deux routes distinctes
    // et masquerait un renommage. Les regex API_SURFACE sont assez spécifiques
    // pour qu'un match en commentaire reste rare et sans conséquence (signal,
    // pas preuve).
    const newF = newRaw !== null ? rules.apiSurfaceOfContent(newRaw, rel) : [];
    const oldF = oldRaw !== null ? rules.apiSurfaceOfContent(oldRaw, rel) : [];

    // Regrouper les échantillons par règle (id) : on ne compare que du même type
    // de surface (endpoint vs endpoint, pas endpoint vs migration).
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
 * Calcule l'analyse d'impact et retourne `data`. Sans effet de bord.
 * opts = { root, symbols, files, diff, base, workspace }
 *   symbols/files : tableau OU chaîne séparée par des virgules.
 */
function run(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const cfg = config.load(root);
  if (opts.workspace) cfg.workspace = opts.workspace;

  const files = scan.walk(root, cfg);
  const mode = opts.diff ? 'diff' : 'plan';
  const base = opts.base && opts.base !== true ? opts.base : (opts.diff ? 'origin/main' : null);

  // 1. Déterminer le périmètre d'entrée : symboles explicites, fichiers, ou diff.
  let targetFiles = toList(opts.files);
  let symbolNames = toList(opts.symbols);

  if (mode === 'diff') {
    targetFiles = [...new Set([...targetFiles, ...git.changedFiles(root, base)])];
  }
  targetFiles = scan.filterPaths(targetFiles, cfg);

  // Si on a des fichiers mais pas de symboles, on extrait les déclarations
  // pour savoir quoi chercher.
  if (!symbolNames.length && targetFiles.length) {
    const decls = [];
    for (const rel of targetFiles) {
      const content = scan.read(root, rel);
      if (content === null) continue;
      decls.push(...scan.declarations(rel, content));
    }
    // Les types d'abord : un nom de propriété comme `Status` génère surtout du
    // bruit. On ne descend aux membres que s'il reste de la place.
    const types = [...new Set(decls.filter(d => d.kind === 'type').map(d => d.name))];
    // Si les types couvrent déjà le périmètre, ajouter leurs membres n'apporte
    // que du bruit : les appelants du type incluent les appelants des membres.
    const members = types.length >= 3 ? [] :
      [...new Set(decls.filter(d => d.kind !== 'type').map(d => d.name))]
        .filter(n => n.length >= 6).slice(0, 6);
    symbolNames = [...types, ...members].slice(0, 12);
  }

  // 2. Localiser chaque symbole et trouver ses références.
  const symbols = [];
  const refsBySymbol = {};
  const allCallers = [];

  for (const name of symbolNames) {
    // On collecte TOUTES les déclarations, pas seulement la première. Une
    // recherche par nom fusionne deux `Order` de namespaces différents ; le
    // moins qu'on puisse faire est de le détecter et de le dire, plutôt que de
    // présenter un périmètre faussement précis. (Focus .NET : les namespaces
    // C# rendent l'homonymie fréquente.)
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

  // 3. Couplage historique.
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

  // 4. Règles de risque.
  const inspectFiles = [...new Set([
    ...targetFiles,
    ...symbols.map(s => s.declFile).filter(Boolean),
    ...coupling.slice(0, 15).map(c => c.file),
  ])];
  const diffTxt = mode === 'diff' ? git.diffText(root, base) : null;
  const irr = rules.irreversible(root, inspectFiles, diffTxt);
  // La surface publique des fichiers couplés compte autant : c'est souvent
  // l'endpoint qui change avec le domaine sans être nommé dans le ticket.
  const api = rules.apiSurface(root, inspectFiles);
  // Diff avant/après de la surface publique : seulement en mode diff avec base.
  const apiBreaking = (mode === 'diff' && base) ? computeApiBreaking(root, base, targetFiles) : [];
  const tests = rules.affectedTests(cfg, refsBySymbol, coupling);

  // 5. Cross-repo optionnel : scan des repos frères du workspace.
  const crossRepo = cfg.workspace ? scanWorkspace(cfg, symbolNames, root) : [];

  const summary = {
    callers: symbols.reduce((a, s) => a + s.callSites, 0),
    apiSurface: api.length,
    crossRepo: new Set(crossRepo.map(r => r.repo)).size,
    externalConsumers: (cfg.externalConsumers || []).length,
    irreversible: irr,
  };
  const risk = rules.riskLevel(cfg, summary);

  // Indices d'historique eonix-memory : ADVISORY seulement. Calculés APRÈS le
  // risque et jamais réinjectés dedans — le gate reste déterministe. Vide si
  // memoryPath non configuré (dégradation gracieuse).
  const priorHints = memory.priorHints(memory.load(cfg, root), symbols, targetFiles);

  // Empreintes de tous les fichiers que le gate considérera comme « couverts ».
  // Sans elles, un rapport frais mais portant sur une version antérieure du
  // fichier laisserait passer une modification à l'aveugle.
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
 * Matérialise le rapport. Le hook et le reviewer lisent ces deux fichiers.
 * Séparé de run() pour qu'un appelant puisse calculer sans écrire (test,
 * dry-run) — mais tout transport qui veut nourrir le gate DOIT appeler ceci.
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
 * Alimente eonix-memory à partir des commits de revert récents. Orchestration
 * (git + scan + memory) placée ici pour rester DRY : la commande CLI `record
 * --from-reverts` ET le git hook post-merge appellent cette même fonction,
 * sans dupliquer la logique et sans salir memory.js (qui reste pur fs/path).
 * Idempotent, non bloquant, no-op si memoryPath absent ou hors repo git.
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
