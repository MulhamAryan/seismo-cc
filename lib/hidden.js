'use strict';
/**
 * Hidden-dependency checks (P1). Cheap, build-free lexical scans that shrink the
 * "Blind spots" list by moving items from "blind" to "searched and reported":
 *
 *  - reflection-string : the symbol's NAME appears inside a string literal —
 *    reflection, convention-based DI, serialization and config reference types
 *    by name, not by a resolved call, so the reference search misses them.
 *  - sql-table         : a table name derived from an entity symbol appears in a
 *    SQL statement (in `.sql` files or hardcoded in code) — the call graph never
 *    sees hardcoded SQL.
 *  - dynamic-construct : reflection / convention-DI APIs are present near the
 *    change (a place where a dependency can be resolved implicitly).
 *  - route-concat      : a URL/route is built by string concatenation, so its
 *    target cannot be resolved statically.
 *
 * ADVISORY ONLY. Like priorHints, these findings are computed after the risk
 * verdict and never fed back into it, so the PreToolUse gate stays deterministic.
 * They are heuristic signals ("possible hidden dependency"), never proof.
 */
const scan = require('./scan');

// String literals (single line for '/"; multi-line for backticks), matching the
// same shapes stripNoise recognizes.
const STRING_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

// SQL statements referencing a table: FROM/JOIN/UPDATE/INTO/TABLE/TRUNCATE <name>.
// Runs on raw content so it also catches SQL hardcoded inside code strings.
const SQL_KW_RE = /\b(FROM|JOIN|UPDATE|INTO|TABLE|TRUNCATE)\s+["'`\[]?([A-Za-z_]\w*)/gi;

// Reflection / convention-DI API surfaces. Matched on stripped code (so a match
// in a comment or a blanked string does not count) except where the string is
// the signal itself.
const DYNAMIC = [
  { id: 'reflection', label: 'Reflection / dynamic type activation', re: /\bType\.GetType\s*\(|\bActivator\.CreateInstance\s*\(|\.GetMethod\s*\(|\bGetType\s*\(\s*["']/ },
  { id: 'convention-di', label: 'Convention-based DI registration', re: /\bservices\.Scan\s*\(|\bAddClasses\s*\(|FromAssembl|->make\s*\(\s*["']|\bresolve\s*\(\s*["']|\bapp\s*\(\s*["']/ },
];

// A route/URL assembled by concatenation: "…/…" + x  or  x + "/…".
const ROUTE_CONCAT = /["'][^"'\n]*\/[^"'\n]*["']\s*\+|\+\s*["'][^"'\n]*\/[^"'\n]*["']/;

const STRING_HITS_MAX = 25;
const SQL_HITS_MAX = 20;

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

// The symbol name appears inside a string literal, and that literal looks like a
// code token (an identifier / dotted path / assembly-qualified name), NOT prose.
// The "no whitespace, or assembly-qualified" test drops log messages like
// "OrderService failed to start" while keeping "App.Domain.OrderService" and
// "OrderService, MyAssembly".
function stringMentions(root, files, names) {
  const useful = [...new Set(names)].filter(n => n && n.length >= 4);
  if (!useful.length) return [];
  const nameRe = new RegExp(`\\b(${useful.map(scan.escapeRe).join('|')})\\b`);
  const out = [];
  for (const rel of files) {
    const raw = scan.read(root, rel);
    if (raw === null) continue;
    if (!useful.some(n => raw.includes(n))) continue;
    STRING_RE.lastIndex = 0;
    let m;
    while ((m = STRING_RE.exec(raw)) !== null) {
      const lit = m[0];
      const inner = lit.slice(1, -1);
      const hit = nameRe.exec(inner);
      if (!hit) continue;
      const looksLikeToken = !/\s/.test(inner) || inner.includes(', ');
      if (!looksLikeToken) continue;
      out.push({ kind: 'reflection-string', symbol: hit[1], file: rel, line: lineOf(raw, m.index), evidence: lit.slice(0, 80) });
      if (out.length >= STRING_HITS_MAX) return out;
    }
  }
  return out;
}

// A table name derived from an entity type (Type or Type+"s") appears in a SQL
// statement. Naive pluralization on purpose: a false match is an advisory line,
// not a risk change.
function sqlTables(root, files, symbols) {
  const types = symbols.filter(s => s.kind === 'type' && s.name && s.name.length >= 3).map(s => s.name);
  if (!types.length) return [];
  const cands = new Map();               // lowercase candidate table -> origin symbol
  for (const t of types) { cands.set(t.toLowerCase(), t); cands.set((t + 's').toLowerCase(), t); }
  const out = [];
  for (const rel of files) {
    const raw = scan.read(root, rel);
    if (raw === null) continue;
    SQL_KW_RE.lastIndex = 0;
    let m;
    while ((m = SQL_KW_RE.exec(raw)) !== null) {
      const origin = cands.get(m[2].toLowerCase());
      if (!origin) continue;
      out.push({ kind: 'sql-table', symbol: origin, file: rel, line: lineOf(raw, m.index), evidence: `${m[1]} ${m[2]}` });
      if (out.length >= SQL_HITS_MAX) return out;
    }
  }
  return out;
}

// Reflection / convention-DI APIs and concatenated routes present in the files
// directly involved in the change (targets + declaration files). Local and cheap.
function dynamicConstructs(root, inspectFiles) {
  const out = [];
  for (const rel of inspectFiles) {
    const raw = scan.read(root, rel);
    if (raw === null) continue;
    const clean = scan.stripNoise(raw, rel);
    for (const d of DYNAMIC) {
      const m = d.re.exec(clean);
      if (m) out.push({ kind: 'dynamic-construct', id: d.id, label: d.label, file: rel, line: lineOf(clean, m.index), evidence: m[0].trim() });
    }
    const idx = raw.search(ROUTE_CONCAT);
    if (idx !== -1) {
      out.push({ kind: 'route-concat', label: 'Route/URL built by concatenation', file: rel, line: lineOf(raw, idx), evidence: raw.slice(idx, idx + 60).split('\n')[0].trim() });
    }
  }
  return out;
}

/**
 * Run every hidden-dependency check. Returns a flat array of advisory findings.
 *   root         : repo root
 *   files        : all scanned files (for the repo-wide string / SQL scans)
 *   symbols      : resolved symbols (name, kind, …)
 *   inspectFiles : the files directly involved in the change (dynamic constructs)
 */
function check(root, files, symbols, inspectFiles) {
  const names = symbols.map(s => s.name);
  return [
    ...stringMentions(root, files, names),
    ...sqlTables(root, files, symbols),
    ...dynamicConstructs(root, inspectFiles || []),
  ];
}

module.exports = { check, stringMentions, sqlTables, dynamicConstructs };
