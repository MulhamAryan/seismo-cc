'use strict';
const { execFileSync } = require('child_process');

function git(root, args) {
  try {
    // stderr captured and not inherited: outside a git repo, the tool must
    // degrade silently, not pollute the agent's output.
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
 * Files modified relative to a base (merge-base included so we don't count the
 * base's commits that have been absorbed since).
 */
function changedFiles(root, base) {
  if (!base) {
    const out = git(root, ['status', '--porcelain']);
    return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
  }
  const mb = git(root, ['merge-base', 'HEAD', base]).trim() || base;
  const parts = [
    git(root, ['diff', '--name-only', `${mb}...HEAD`]),   // branch commits
    git(root, ['diff', '--name-only', '--cached']),        // index
    git(root, ['diff', '--name-only']),                    // working tree
    git(root, ['ls-files', '--others', '--exclude-standard']), // untracked
  ];
  return [...new Set(parts.join('\n').split('\n').map(s => s.trim()).filter(Boolean))];
}

// Content of a file at a given revision (`git show ref:path`). Returns null if
// the file doesn't exist at that revision — new file, renamed path: the caller
// treats this as an empty public surface on the "before" side.
function showFile(root, ref, rel) {
  if (!ref || !rel) return null;
  const out = git(root, ['show', `${ref}:${rel}`]);
  return out === '' ? null : out;
}

// Common ancestor HEAD..base — the same base that changedFiles/diffText use,
// so the API's "before" matches exactly the diff being analyzed.
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
 * Co-change coupling: which files change HISTORICALLY together with the target.
 * It's the most useful signal of the bunch, because it's language-agnostic and
 * catches precisely what static analysis doesn't see: config in the database,
 * hardcoded SQL, reflection, convention-based DI, docs to update.
 */
function coupling(root, files, opts) {
  const { depth = 400 } = opts || {};
  // A single `git log` without a pathspec: with a pathspec, --name-only lists
  // only the matching files, which makes any coupling invisible.
  return couplingFrom(commitIndex(root, depth), files, opts);
}

/**
 * Pure co-change coupling over an EXPLICIT commit list, independent of any repo.
 * Extracted from `coupling` so the validation harness (test/validate.js) can
 * feed it a temporally-restricted slice of history (prior commits only) and
 * measure the predictor without leakage. `coupling(root, …)` is just this over
 * `commitIndex(root, depth)`.
 */
function couplingFrom(commits, files, opts) {
  const { minCommits = 3, minRatio = 0.4 } = opts || {};
  const result = new Map();
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
 * sha -> touched files, for the whole history window. Memoized because the
 * cross-repo scan calls this once per repo.
 * -m makes merges appear, otherwise merge commits are empty and the coupling
 * on feature branches disappears.
 */
function commitIndex(root, depth) {
  const key = `${root}|${depth}`;
  if (_indexCache.has(key)) return _indexCache.get(key);
  const log = git(root, ['log', `-n${depth}`, '--format=%H', '--name-only', '--no-renames', '-m', '--first-parent']);
  const commits = parseLog(log);
  _indexCache.set(key, commits);
  return commits;
}

// `-m` makes a merge commit appear once PER parent: the same SHA thus recurs
// several times in the log, with overlapping file lists. Without deduplication,
// `touching.length` and the co-change counters are inflated on merge-heavy
// histories. We merge by SHA and dedupe the files.
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
 * Churn: number of commits touching the file. A highly unstable file deserves
 * more caution than one that's been frozen for two years.
 */
function churn(root, file, depth = 400) {
  const out = git(root, ['log', `-n${depth}`, '--format=%H', '--', file]);
  return out.split('\n').filter(Boolean).length;
}

/**
 * Last significant author — useful for knowing who to warn, not for assigning
 * blame.
 */
function lastAuthors(root, file, n = 3) {
  const out = git(root, ['log', `-n${n}`, '--format=%an', '--', file]);
  return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))];
}

/**
 * Recent revert commits and the files they touch. A `git revert` produces a
 * commit whose body contains "This reverts commit <sha>": the most reliable and
 * automatable signal of an incident (a change had to be undone). The files of
 * the revert commit = the problematic scope. Serves as the source for
 * `impact record --from-reverts` to feed seismo-memory.
 * Returns: [{ sha, date, subject, files: [...] }] from most recent to oldest.
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

module.exports = { git, isRepo, head, currentBranch, changedFiles, diffText, showFile, mergeBase, coupling, couplingFrom, commitIndex, churn, lastAuthors, parseLog, recentReverts };
