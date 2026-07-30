'use strict';
const { execFileSync } = require('child_process');

function git(root, args) {
  try {
    // stderr capturé et non hérité : hors repo git, l'outil doit se dégrader
    // silencieusement, pas polluer la sortie de l'agent.
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return '';
  }
}

function isRepo(root) {
  return git(root, ['rev-parse', '--git-dir']).trim().length > 0;
}

function head(root) {
  return git(root, ['rev-parse', 'HEAD']).trim() || null;
}

function currentBranch(root) {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null;
}

/**
 * Fichiers modifiés par rapport à une base (merge-base incluse pour ne pas
 * compter les commits de la base absorbés depuis).
 */
function changedFiles(root, base) {
  if (!base) {
    const out = git(root, ['status', '--porcelain']);
    return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
  }
  const mb = git(root, ['merge-base', 'HEAD', base]).trim() || base;
  const parts = [
    git(root, ['diff', '--name-only', `${mb}...HEAD`]),   // commits de la branche
    git(root, ['diff', '--name-only', '--cached']),        // index
    git(root, ['diff', '--name-only']),                    // arbre de travail
    git(root, ['ls-files', '--others', '--exclude-standard']), // non suivis
  ];
  return [...new Set(parts.join('\n').split('\n').map(s => s.trim()).filter(Boolean))];
}

// Contenu d'un fichier à une révision donnée (`git show ref:path`). Renvoie
// null si le fichier n'existe pas à cette révision — nouveau fichier, chemin
// renommé : l'appelant traite ça comme une surface publique vide côté « avant ».
function showFile(root, ref, rel) {
  if (!ref || !rel) return null;
  const out = git(root, ['show', `${ref}:${rel}`]);
  return out === '' ? null : out;
}

// Ancêtre commun HEAD..base — la même base que changedFiles/diffText utilisent,
// pour que le « avant » de l'API corresponde exactement au diff analysé.
function mergeBase(root, base) {
  if (!base) return null;
  return git(root, ['merge-base', 'HEAD', base]).trim() || base;
}

function diffText(root, base) {
  if (!base) return git(root, ['diff', 'HEAD']);
  const mb = git(root, ['merge-base', 'HEAD', base]).trim() || base;
  return [
    git(root, ['diff', `${mb}...HEAD`]),
    git(root, ['diff', '--cached']),
    git(root, ['diff']),
  ].join('\n');
}

/**
 * Couplage de co-changement : quels fichiers changent HISTORIQUEMENT avec
 * la cible. C'est le signal le plus utile du lot, parce qu'il est
 * language-agnostic et qu'il attrape précisément ce que l'analyse statique
 * ne voit pas : la config en base, le SQL en dur, la réflexion, le DI par
 * convention, la doc à mettre à jour.
 */
function coupling(root, files, opts) {
  const { depth = 400, minCommits = 3, minRatio = 0.4 } = opts || {};
  const result = new Map();
  // Un seul `git log` sans pathspec : avec un pathspec, --name-only ne liste
  // que les fichiers correspondants, ce qui rend tout couplage invisible.
  const commits = commitIndex(root, depth);
  for (const f of files) {
    const touching = commits.filter(c => c.files.includes(f));
    if (touching.length < minCommits) continue;
    const counts = new Map();
    for (const c of touching) {
      for (const other of c.files) {
        if (other === f) continue;
        counts.set(other, (counts.get(other) || 0) + 1);
      }
    }
    for (const [other, n] of counts) {
      const ratio = n / touching.length;
      if (n < minCommits || ratio < minRatio) continue;
      const prev = result.get(other);
      const entry = { file: other, commits: n, of: touching.length, ratio, via: f };
      if (!prev || prev.ratio < ratio) result.set(other, entry);
    }
  }
  return [...result.values()].sort((a, b) => b.ratio - a.ratio || b.commits - a.commits);
}

const _indexCache = new Map();

/**
 * sha -> fichiers touchés, pour toute la fenêtre d'historique. Mémoïsé parce
 * que le cross-repo appelle ceci une fois par repo.
 * -m fait apparaître les merges, sinon les commits de merge sont vides et le
 * couplage sur les branches de feature disparaît.
 */
function commitIndex(root, depth) {
  const key = `${root}|${depth}`;
  if (_indexCache.has(key)) return _indexCache.get(key);
  const log = git(root, ['log', `-n${depth}`, '--format=%H', '--name-only', '--no-renames', '-m', '--first-parent']);
  const commits = parseLog(log);
  _indexCache.set(key, commits);
  return commits;
}

// `-m` fait apparaître un commit de merge une fois PAR parent : le même SHA
// revient donc plusieurs fois dans le log, avec des listes de fichiers qui se
// recoupent. Sans déduplication, `touching.length` et les compteurs de
// co-changement sont gonflés sur les historiques riches en merges. On fusionne
// par SHA et on dédoublonne les fichiers.
function parseLog(log) {
  const bySha = new Map();
  let cur = null;
  for (const line of log.split('\n')) {
    const t = line.trim();
    if (/^[0-9a-f]{40}$/.test(t)) {
      if (bySha.has(t)) {
        cur = bySha.get(t);
      } else {
        cur = { sha: t, files: [], _seen: new Set() };
        bySha.set(t, cur);
      }
    } else if (t && cur) {
      if (!cur._seen.has(t)) { cur._seen.add(t); cur.files.push(t); }
    }
  }
  const commits = [...bySha.values()];
  for (const c of commits) delete c._seen;
  return commits;
}

/**
 * Churn : nombre de commits touchant le fichier. Un fichier très instable
 * mérite plus de prudence qu'un fichier figé depuis deux ans.
 */
function churn(root, file, depth = 400) {
  const out = git(root, ['log', `-n${depth}`, '--format=%H', '--', file]);
  return out.split('\n').filter(Boolean).length;
}

/**
 * Dernier auteur significatif — utile pour savoir qui prévenir, pas pour
 * distribuer les blâmes.
 */
function lastAuthors(root, file, n = 3) {
  const out = git(root, ['log', `-n${n}`, '--format=%an', '--', file]);
  return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))];
}

/**
 * Commits de revert récents et les fichiers qu'ils touchent. Un `git revert`
 * produit un commit dont le corps contient « This reverts commit <sha> » : le
 * signal le plus fiable et automatable d'un incident (on a dû annuler un
 * changement). Les fichiers du commit de revert = le périmètre problématique.
 * Sert de source à `impact record --from-reverts` pour alimenter seismo-memory.
 * Retour : [{ sha, date, subject, files: [...] }] du plus récent au plus ancien.
 */
function recentReverts(root, depth = 200) {
  const MARK = '__CMT__';
  const log = git(root, [
    'log', `-n${depth}`, '--grep=This reverts commit',
    `--format=${MARK}%H|%cI|%s`, '--name-only', '--no-renames',
  ]);
  const out = [];
  let cur = null;
  for (const raw of log.split('\n')) {
    if (raw.startsWith(MARK)) {
      const [sha, date, ...subj] = raw.slice(MARK.length).split('|');
      cur = { sha, date, subject: subj.join('|'), files: [] };
      out.push(cur);
    } else {
      const t = raw.trim();
      if (t && cur && !cur.files.includes(t)) cur.files.push(t);
    }
  }
  return out;
}

module.exports = { git, isRepo, head, currentBranch, changedFiles, diffText, showFile, mergeBase, coupling, commitIndex, churn, lastAuthors, parseLog, recentReverts };
