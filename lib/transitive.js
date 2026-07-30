'use strict';
/**
 * Indirect (2-hop) impact (P3 in docs/ROADMAP.md).
 *
 * The direct analysis is one hop: files that reference the changed symbol. The
 * most common real-world miss is second-order — A calls B calls the changed
 * symbol, so a change can ripple to A even though A never names the symbol.
 *
 * This computes exactly one extra hop, capped:
 *   hop 1  the direct caller files (already found by scan.references)
 *   hop 1' the TYPE symbols those caller files declare        (the seeds)
 *   hop 2  the files that reference those seed types          (indirect impact)
 *
 * It is deliberately shallow and bounded — no full transitive closure, which
 * would require a resolved graph (see ROADMAP P4). It is REPORT-ONLY: like the
 * advisory layers, it never enters the risk computation or the gate, so the
 * deterministic guarantee is preserved. Its confidence is lower than the direct
 * callers' by construction (two lexical hops, no type resolution), and it is
 * labelled as such.
 */
const scan = require('./scan');

const MAX_SEED_FILES = 10;     // direct caller files whose declarations we expand
const MAX_SEED_SYMBOLS = 12;   // hop-1' type symbols expanded (bounds the cost)
const MAX_RESULT_FILES = 30;   // indirect files reported

/**
 * @param root  repo root
 * @param files all scanned files
 * @param opts.directFiles  Set of direct caller files (hop 1)
 * @param opts.exclude      Set of files never reported (targets, decls, direct callers)
 * @param opts.excludeNames names already analyzed directly (do not re-expand them)
 * @returns [{ file, count, via: [seedType…], confidence: 'indirect' }]
 */
function indirectImpact(root, files, opts = {}) {
  const directFiles = opts.directFiles || new Set();
  const exclude = opts.exclude || new Set();
  const excludeNames = new Set(opts.excludeNames || []);

  // hop 1': collect the TYPE symbols declared in the direct caller files. Types
  // only — expanding every member would explode the fan-out with little signal.
  const seeds = [];
  const seen = new Set(excludeNames);
  for (const rel of [...directFiles].slice(0, MAX_SEED_FILES)) {
    const content = scan.read(root, rel);
    if (content === null) continue;
    for (const d of scan.declarationsCached(rel, content)) {
      if (d.kind !== 'type' || seen.has(d.name)) continue;
      seen.add(d.name);
      seeds.push({ name: d.name, declFile: rel });
      if (seeds.length >= MAX_SEED_SYMBOLS) break;
    }
    if (seeds.length >= MAX_SEED_SYMBOLS) break;
  }
  if (!seeds.length) return [];

  // hop 2: who references those seed types, outside the already-covered set.
  const byFile = new Map();
  for (const seed of seeds) {
    const refs = scan.references(root, files, seed.name, seed.declFile);
    for (const r of refs) {
      if (exclude.has(r.file) || directFiles.has(r.file) || r.file === seed.declFile) continue;
      const e = byFile.get(r.file) || { file: r.file, count: 0, via: new Set() };
      e.count += r.count;
      e.via.add(seed.name);
      byFile.set(r.file, e);
    }
  }

  return [...byFile.values()]
    .map(e => ({ file: e.file, count: e.count, via: [...e.via].slice(0, 3), confidence: 'indirect' }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, MAX_RESULT_FILES);
}

module.exports = { indirectImpact, MAX_RESULT_FILES };
