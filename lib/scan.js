'use strict';
const fs = require('fs');
const path = require('path');

// An exclusion pattern matches on path segment BOUNDARIES, never on a raw
// substring. The substring version silently excluded legitimate files:
// `routes/web.php` (contains "out"), `Distance.cs` (contains "dist"),
// `query_builder.php` (contains "build") — i.e. the very public surface the
// tool claims to detect.
function ignored(rel, name, ignore) {
  const segs = rel.split('/');
  for (const pat of ignore) {
    if (pat.startsWith('*')) {
      // Suffix glob: *.min.js, *.designer.cs, *.lock
      if (name.endsWith(pat.slice(1))) return true;
    } else if (pat.includes('/')) {
      // Multi-segment pattern (e.g. wwwroot/lib): matched anchored on boundaries.
      const p = pat.endsWith('/') ? pat.slice(0, -1) : pat;
      if (`/${rel}/`.includes(`/${p}/`)) return true;
    } else {
      // Simple pattern: must be a WHOLE segment, not a substring.
      if (segs.includes(pat)) return true;
    }
  }
  return false;
}

function walk(root, cfg, limit = 40000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ignored(rel, e.name, cfg.ignore)) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        if (cfg.extensions.some(ext => rel.endsWith(ext))) out.push(rel);
      }
    }
  }
  return out;
}

// Resolution walks the tree once per symbol. Without a cache, we do
// O(symbols × files) disk reads, which becomes noticeable beyond a few
// thousand files — and this path runs inside a hook.
const _readCache = new Map();
const READ_CACHE_MAX = 20000;

function read(root, rel) {
  const key = root + '\u0000' + rel;
  if (_readCache.has(key)) return _readCache.get(key);
  let value = null;
  try {
    const full = path.join(root, rel);
    const st = fs.statSync(full);
    if (st.size <= 2 * 1024 * 1024) value = fs.readFileSync(full, 'utf8');
  } catch {
    value = null;
  }
  if (_readCache.size < READ_CACHE_MAX) _readCache.set(key, value);
  return value;
}

// Declaration cache, for the same reason.
const _declCache = new Map();

function declarationsCached(rel, content) {
  if (_declCache.has(rel)) return _declCache.get(rel);
  const d = declarations(rel, content);
  _declCache.set(rel, d);
  return d;
}

// ---------------------------------------------------------------------------
// Language adapters: declaration extraction.
// Deliberately based on regular expressions rather than a parser.
// This is a conscious trade-off: it works on any repo without a build, at the
// cost of false negatives on exotic cases. The report says so.
// ---------------------------------------------------------------------------
const DECL = {
  cs: [
    { kind: 'type', re: /^\s*(?:\[[^\]]*\]\s*)*(?:public|internal|protected|private|abstract|sealed|static|partial|readonly|\s)*\b(class|record|struct|interface|enum)\s+([A-Z]\w*)/gm, group: 2 },
    // Methods: at least ONE modifier required, otherwise `return Foo()` or
    // `throw New()` would be taken for declarations. Now covers `private`,
    // combinations, leading attributes and generics. Expression-bodied methods
    // `T Foo() => …` have a `(`: already captured.
    { kind: 'method', re: /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|internal|protected|static|virtual|override|async|sealed|new|abstract|partial)\s+)+[\w<>\[\],?\s.]+?\s+([A-Z]\w*)\s*(?:<[^>]*>)?\s*\(/gm, group: 1 },
    // Properties: `{ get` accessor OR expression-bodied `=>`.
    { kind: 'property', re: /^\s*(?:\[[^\]]*\]\s*)*public\s+(?:virtual\s+|required\s+|static\s+)?[\w<>\[\],?]+\s+([A-Z]\w*)\s*(?:\{\s*get|=>)/gm, group: 1 },
  ],
  php: [
    { kind: 'type', re: /^\s*(?:final\s+|abstract\s+)?(class|interface|trait|enum)\s+(\w+)/gm, group: 2 },
    { kind: 'method', re: /^\s*(?:public|protected|private)?\s*(?:static\s+)?function\s+(\w+)\s*\(/gm, group: 1 },
  ],
  kt: [
    { kind: 'type', re: /^\s*(?:public\s+|internal\s+|abstract\s+|sealed\s+|data\s+|open\s+)*(class|object|interface|enum class)\s+(\w+)/gm, group: 2 },
    { kind: 'method', re: /^\s*(?:public\s+|internal\s+|override\s+|suspend\s+|private\s+)*fun\s+(?:<[^>]+>\s*)?(\w+)\s*\(/gm, group: 1 },
  ],
  ts: [
    { kind: 'type', re: /^\s*export\s+(?:abstract\s+)?(class|interface|type|enum)\s+(\w+)/gm, group: 2 },
    { kind: 'method', re: /^\s*export\s+(?:async\s+)?function\s+(\w+)|^\s*export\s+const\s+(\w+)\s*=/gm, group: 1 },
  ],
};

function adapterFor(rel) {
  if (rel.endsWith('.cs') || rel.endsWith('.razor') || rel.endsWith('.cshtml')) return 'cs';
  if (rel.endsWith('.php')) return 'php';
  if (rel.endsWith('.kt') || rel.endsWith('.kts')) return 'kt';
  if (/\.(ts|tsx|js|jsx|vue)$/.test(rel)) return 'ts';
  return null;
}

function declarations(rel, content) {
  const ad = adapterFor(rel);
  if (!ad || !DECL[ad]) return [];
  const found = [];
  for (const rule of DECL[ad]) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(content)) !== null) {
      const name = m[rule.group] || m[1] || m[2];
      if (!name || name.length < 3) continue;
      if (NOISE.has(name)) continue;
      found.push({ name, kind: rule.kind, file: rel, line: lineOf(content, m.index) });
    }
  }
  return found;
}

// Words that look like symbols but aren't, or that are too generic for a
// name-based search to yield a usable result.
const NOISE = new Set([
  'Main', 'Program', 'Startup', 'Get', 'Set', 'Run', 'Execute', 'Handle', 'Invoke',
  'ToString', 'Equals', 'GetHashCode', 'Dispose', 'Configure', 'ConfigureServices',
  'Index', 'Create', 'Update', 'Delete', 'Store', 'Show', 'Edit', 'Up', 'Down',
]);

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

// C# namespace containing a given line. Handles the block form
// (`namespace Foo.Bar {`) and the file-scoped form (`namespace Foo.Bar;`).
// Heuristic: the last `namespace` declared before the line. Used to tell apart
// two same-named symbols from different namespaces.
const _nsRe = /^\s*namespace\s+([A-Za-z_][\w.]*)/;
function namespaceAt(content, line) {
  const lines = content.split('\n');
  let ns = null;
  for (let i = 0; i < line && i < lines.length; i++) {
    const m = _nsRe.exec(lines[i]);
    if (m) ns = m[1];
  }
  return ns;
}

/**
 * Roughly strips comments and string literals before counting references.
 * Rough on purpose: a real parser would require a build, which kills the
 * "any project" goal.
 */
// Extracts interpolation expressions `{…}` (C#) and returns them bare, without
// quotes, so that the real references they contain
// (`$"total = {OrderService.Sum()}"`) stay counted — while removing the literal
// text around them. Without quotes, the generic string pass doesn't strip them
// again.
function keepCsHoles(m) {
  const holes = [];
  const re = /\{([^{}]+)\}/g;
  let x;
  while ((x = re.exec(m)) !== null) holes.push(x[1]);
  return ' ' + holes.join(' ') + ' ';
}
function keepTsHoles(m) {
  const holes = [];
  const re = /\$\{([^{}]+)\}/g;
  let x;
  while ((x = re.exec(m)) !== null) holes.push(x[1]);
  return ' ' + holes.join(' ') + ' ';
}

function stripNoise(content, rel) {
  let c = content;
  // Comments.
  c = c.replace(/\/\*[\s\S]*?\*\//g, ' ');
  c = c.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  if (rel.endsWith('.php')) c = c.replace(/(^|\s)#[^\n]*/g, '$1 ');

  const ad = adapterFor(rel);
  if (ad === 'cs') {
    // Order matters: interpolated BEFORE verbatim (otherwise the `@"` in `$@"`
    // would be eaten), verbatim BEFORE generic strings (multi-line).
    // - `@"...""..."`  : verbatim, `""` = escaped quote
    // - `$"...{x}..."` / `$@"...{x}..."` : we preserve the `{x}` expressions
    c = c.replace(/\$@"(?:[^"]|"")*"|@\$"(?:[^"]|"")*"/g, keepCsHoles);
    c = c.replace(/\$"(?:[^"\\]|\\.)*"/g, keepCsHoles);
    c = c.replace(/@"(?:[^"]|"")*"/g, '""');
  } else if (ad === 'ts') {
    // Template literals: we keep the `${expr}`.
    c = c.replace(/`(?:[^`\\]|\\.)*`/g, keepTsHoles);
  }

  // Generic strings (do not cross line breaks).
  c = c.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  c = c.replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  return c;
}

// ---------------------------------------------------------------------------
// (1) Import graph and declaring module — improves name-based resolution
// outside .NET. Without types or a build, we can't prove that a `save()` is
// THE one we're looking for; but we can know whether the file actually IMPORTS
// the symbol (or lives in the same module) and weight confidence accordingly.
// The raw count stays unchanged — we only annotate — for zero regression on
// the risk score.
// ---------------------------------------------------------------------------

// Extraction of the short imported name, per language. The last segment of a
// PHP `use` / Kotlin `import` is the local name; in TS we read the destructured
// names `{ A, B as C }` and the default import.
const IMPORT_RE = {
  php: /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm,
  kt: /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm,
  ts: /^\s*import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:from\s+)?['"][^'"]+['"]/gm,
};

// Short names imported in the file. Serves as a confidence signal: a reference
// to `Order` in a file that explicitly imports `Order` is almost certainly THAT
// `Order` — which disambiguates cross-module homonyms.
function importedNames(content, rel) {
  const ad = adapterFor(rel);
  const names = new Set();
  const reDef = IMPORT_RE[ad];
  if (!reDef) return names;
  reDef.lastIndex = 0;
  let m;
  while ((m = reDef.exec(content)) !== null) {
    if (ad === 'ts') {
      if (m[1]) names.add(m[1]);                       // default import
      if (m[2]) {                                        // named `{ A, B as C }`
        for (const part of m[2].split(',')) {
          const seg = part.trim().split(/\s+as\s+/);
          const local = (seg[1] || seg[0] || '').trim();
          if (local && local !== '*') names.add(local);
        }
      }
    } else {
      const alias = m[2];
      const full = m[1] || '';
      const short = ad === 'php' ? full.split('\\').pop() : full.split('.').pop();
      names.add(alias || short);
    }
  }
  return names;
}

// FULL import path bound to a local name (php/kt only — in TS the specifier is
// a file path, not a symbol path). Lets us tell apart two homonyms:
// `use App\A\Order` vs `use App\B\Order` both import an `Order`, but only one
// points to the declaration being sought.
function importPathFor(content, rel, name) {
  const ad = adapterFor(rel);
  if (ad !== 'php' && ad !== 'kt') return null;
  const reDef = IMPORT_RE[ad];
  reDef.lastIndex = 0;
  let m;
  while ((m = reDef.exec(content)) !== null) {
    const full = m[1] || '';
    const short = ad === 'php' ? full.split('\\').pop() : full.split('.').pop();
    const local = m[2] || short;
    if (local === name) return full;
  }
  return null;
}

// Declaring module of a file: PHP namespace, Kotlin package, C# namespace.
// In TS there is no portable module declaration — we return null and fall back
// on the name-based import signal alone.
const _pkgRe = { php: /^\s*namespace\s+([\w\\]+)/m, kt: /^\s*package\s+([\w.]+)/m, cs: /^\s*namespace\s+([\w.]+)/m };
function moduleOf(content, rel) {
  const ad = adapterFor(rel);
  const re = _pkgRe[ad];
  if (!re) return null;
  const m = re.exec(content);
  return m ? m[1] : null;
}

// (2) Nature of a reference based on the preceding token: member call
// (`->`, `.`), static (`::`), instantiation (`new`/`instanceof`). A qualified
// site is a STRONG signal that it's a real symbol and not a bare-word homonym
// (local variable, key, keyword). Returns null if unqualified.
function qualifierBefore(content, idx) {
  let j = idx - 1;
  while (j >= 0 && (content[j] === ' ' || content[j] === '\t')) j--;
  if (j < 0) return null;
  if (content[j] === '.') return 'member';
  if (content[j] === '>' && j >= 1 && content[j - 1] === '-') return 'member';   // ->
  if (content[j] === ':' && j >= 1 && content[j - 1] === ':') return 'static';    // ::
  let k = j;
  while (k >= 0 && /\w/.test(content[k])) k--;
  const prevWord = content.slice(k + 1, j + 1);
  if (prevWord === 'new' || prevWord === 'instanceof') return 'new';
  return null;
}

/**
 * References to a symbol across the whole tree. Returns the call sites grouped
 * by file, excluding the declaration line itself.
 *
 * opts.ambiguous: the symbol has several same-named declarations (the caller
 *   knows this because it scans all declarations). Enables the confidence
 *   downgrade of non-imported / out-of-module sites.
 *
 * Each hit carries `confidence` ('high' | 'normal' | 'low') and `confident`
 * (number of lines with a qualified site or a file importing the symbol). The
 * `count`/`occurrences` counters remain the raw count — additive, so no
 * regression on the existing risk score.
 */
const LINES_SHOWN_MAX = 50;

function references(root, files, symbol, declFile, opts = {}) {
  const ambiguous = !!opts.ambiguous;
  // Reinforced boundary: `(?<![\w$])` rejects `$symbol` (PHP variable, JS
  // identifier `$foo`) that a plain `\b` wrongly matched. The trailing `\b`
  // is enough on the right. Node 18+ supports lookbehind.
  const re = new RegExp(`(?<![\\w$])${escapeRe(symbol)}\\b`, 'g');
  // Module of the declaring file: sites in the same module don't need an
  // import to be reliable (intra-namespace/intra-package usage).
  const declRaw = declFile ? read(root, declFile) : null;
  const declModule = declRaw !== null ? moduleOf(declRaw, declFile) : null;
  const hits = [];
  for (const rel of files) {
    const raw = read(root, rel);
    if (raw === null) continue;
    if (!raw.includes(symbol)) continue; // quick filter before the costly one
    const content = stripNoise(raw, rel);
    const ad = adapterFor(rel);
    // Imports and module are read on the un-cleaned code (real lines).
    // We distinguish three cases via the FULL import path (php/kt):
    //  - importHere      : imports exactly the declaration sought => strong
    //  - importElsewhere : imports a homonym from ANOTHER module => this file
    //    does NOT reference our symbol, regardless of the number of matches
    //  - otherwise : name-only signal (ts) or same module.
    const impPath = importPathFor(raw, rel, symbol);
    const sep = ad === 'php' ? '\\' : '.';
    let importHere = false, importElsewhere = false;
    if (impPath !== null && declModule !== null) {
      if (impPath === declModule + sep + symbol) importHere = true;
      else importElsewhere = true;
    }
    const fileImports = importHere || (impPath === null && importedNames(raw, rel).has(symbol));
    const sameModule = declModule !== null && moduleOf(raw, rel) === declModule;
    re.lastIndex = 0;
    const lineSet = new Set();   // distinct lines, NOT capped: feeds the risk
    const shownLines = [];       // bounded subset, for display only
    let occurrences = 0;         // total matches (can exceed the lines)
    let strong = false;          // at least one qualified site (->/::/new/.)
    let skippedDecl = false;
    let m;
    while ((m = re.exec(content)) !== null) {
      // We skip the declaration line itself exactly once.
      if (rel === declFile && !skippedDecl && isDeclLine(content, m.index)) { skippedDecl = true; continue; }
      // The `use`/`import` line is not a call site: it already served to
      // compute fileImports, recounting it would inflate the scope.
      if (isImportLine(content, m.index)) continue;
      occurrences++;
      if (qualifierBefore(content, m.index)) strong = true;
      const line = lineOf(content, m.index);
      if (!lineSet.has(line)) {
        lineSet.add(line);
        if (shownLines.length < LINES_SHOWN_MAX) shownLines.push(line);
      }
    }
    if (lineSet.size) {
      // Confidence: a file that imports a homonym from ANOTHER module does not
      // reference our symbol => low, even if the sites are qualified (they call
      // the other one). Otherwise: exact import / same module / qualified site
      // = high; ambiguous homonym without signal = low; default normal.
      let confidence = 'normal';
      if (importElsewhere) confidence = 'low';
      else if (fileImports || sameModule || strong) confidence = 'high';
      else if (ambiguous) confidence = 'low';
      hits.push({
        file: rel,
        lines: shownLines,               // bounded display
        count: lineSet.size,             // distinct lines, NOT capped
        occurrences,                     // total matches
        truncated: lineSet.size > shownLines.length,  // display list shortened
        confidence,                      // 'high' | 'normal' | 'low'
        imported: fileImports,           // the file explicitly imports the symbol
      });
    }
  }
  // Sort: line count first (historical behavior unchanged), confidence only
  // serves as a tie-breaker at equal count — no visible reordering on the
  // already-calibrated .NET path.
  const rank = { high: 2, normal: 1, low: 0 };
  return hits.sort((a, b) => (b.count - a.count) || (rank[b.confidence] - rank[a.confidence]));
}

function isImportLine(content, index) {
  const start = content.lastIndexOf('\n', index) + 1;
  const end = content.indexOf('\n', index);
  const line = content.slice(start, end === -1 ? content.length : end);
  return /^\s*(?:use|import)\s/.test(line);
}

function isDeclLine(content, index) {
  const start = content.lastIndexOf('\n', index) + 1;
  const line = content.slice(start, content.indexOf('\n', index));
  return /\b(class|record|struct|interface|enum|trait|object|fun|function)\b/.test(line);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTest(rel, cfg) {
  return cfg.testPatterns.some(p => rel.includes(p));
}

/**
 * Filters the paths provided by git (which don't go through walk and therefore
 * don't inherit the exclusions). Without this, `.impact/report.md` ends up
 * analyzed as source code and the report pollutes itself.
 */
function filterPaths(rels, cfg) {
  return rels.filter(rel => {
    const name = rel.split('/').pop();
    if (rel.startsWith('.impact/')) return false;
    if (ignored(rel, name, cfg.ignore)) return false;
    return cfg.extensions.some(ext => rel.endsWith(ext));
  });
}

module.exports = { walk, read, declarations, declarationsCached, references, isTest, adapterFor, stripNoise, escapeRe, filterPaths, ignored, namespaceAt, importedNames, importPathFor, moduleOf, qualifierBefore };
