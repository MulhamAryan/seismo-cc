'use strict';
const fs = require('fs');
const path = require('path');

// Un motif d'exclusion matche sur des FRONTIÈRES de segment de chemin, jamais
// en sous-chaîne brute. La version sous-chaîne excluait silencieusement des
// fichiers légitimes : `routes/web.php` (contient "out"), `Distance.cs`
// (contient "dist"), `query_builder.php` (contient "build") — donc la surface
// publique elle-même que l'outil prétend détecter.
function ignored(rel, name, ignore) {
  const segs = rel.split('/');
  for (const pat of ignore) {
    if (pat.startsWith('*')) {
      // Glob suffixe : *.min.js, *.designer.cs, *.lock
      if (name.endsWith(pat.slice(1))) return true;
    } else if (pat.includes('/')) {
      // Motif multi-segment (ex: wwwroot/lib) : match ancré sur les frontières.
      const p = pat.endsWith('/') ? pat.slice(0, -1) : pat;
      if (`/${rel}/`.includes(`/${p}/`)) return true;
    } else {
      // Motif simple : doit être un SEGMENT entier, pas une sous-chaîne.
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

// La résolution parcourt l'arbre une fois par symbole. Sans cache, on est en
// O(symboles × fichiers) lectures disque, ce qui devient sensible au-delà de
// quelques milliers de fichiers — et ce chemin est exécuté dans un hook.
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

// Cache des déclarations, pour la même raison.
const _declCache = new Map();

function declarationsCached(rel, content) {
  if (_declCache.has(rel)) return _declCache.get(rel);
  const d = declarations(rel, content);
  _declCache.set(rel, d);
  return d;
}

// ---------------------------------------------------------------------------
// Adaptateurs de langage : extraction des déclarations.
// Volontairement basé sur des expressions régulières et non sur un parseur.
// C'est un compromis assumé : ça marche sur n'importe quel repo sans build,
// au prix de faux négatifs sur les cas exotiques. Le rapport le dit.
// ---------------------------------------------------------------------------
const DECL = {
  cs: [
    { kind: 'type', re: /^\s*(?:\[[^\]]*\]\s*)*(?:public|internal|protected|private|abstract|sealed|static|partial|readonly|\s)*\b(class|record|struct|interface|enum)\s+([A-Z]\w*)/gm, group: 2 },
    // Méthodes : au moins UN modificateur exigé, sinon `return Foo()` ou
    // `throw New()` seraient pris pour des déclarations. Couvre désormais
    // `private`, les combinaisons, les attributs en tête et les génériques.
    // Les méthodes expression-bodied `T Foo() => …` ont un `(` : déjà captées.
    { kind: 'method', re: /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|internal|protected|static|virtual|override|async|sealed|new|abstract|partial)\s+)+[\w<>\[\],?\s.]+?\s+([A-Z]\w*)\s*(?:<[^>]*>)?\s*\(/gm, group: 1 },
    // Propriétés : accesseur `{ get` OU expression-bodied `=>`.
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

// Mots qui ressemblent à des symboles mais n'en sont pas, ou qui sont trop
// génériques pour qu'une recherche par nom donne un résultat exploitable.
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

// Namespace C# contenant une ligne donnée. Gère la forme bloc
// (`namespace Foo.Bar {`) et la forme file-scoped (`namespace Foo.Bar;`).
// Heuristique : le dernier `namespace` déclaré avant la ligne. Sert à
// distinguer deux symboles homonymes de namespaces différents.
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
 * Retire grossièrement commentaires et chaînes littérales avant de compter
 * les références. Grossier volontairement : un vrai parseur exigerait un
 * build, ce qui tue le "n'importe quel projet".
 */
// Extrait les expressions d'interpolation `{…}` (C#) et les rend nues, sans
// guillemets, pour que les vraies références qu'elles contiennent
// (`$"total = {OrderService.Sum()}"`) restent comptées — tout en supprimant le
// texte littéral autour. Sans guillemets, la passe de strings générique ne les
// re-supprime pas.
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
  // Commentaires.
  c = c.replace(/\/\*[\s\S]*?\*\//g, ' ');
  c = c.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  if (rel.endsWith('.php')) c = c.replace(/(^|\s)#[^\n]*/g, '$1 ');

  const ad = adapterFor(rel);
  if (ad === 'cs') {
    // Ordre important : interpolées AVANT verbatim (sinon le `@"` du `$@"`
    // serait mangé), verbatim AVANT les strings génériques (multi-lignes).
    // - `@"...""..."`  : verbatim, `""` = guillemet échappé
    // - `$"...{x}..."` / `$@"...{x}..."` : on préserve les expressions `{x}`
    c = c.replace(/\$@"(?:[^"]|"")*"|@\$"(?:[^"]|"")*"/g, keepCsHoles);
    c = c.replace(/\$"(?:[^"\\]|\\.)*"/g, keepCsHoles);
    c = c.replace(/@"(?:[^"]|"")*"/g, '""');
  } else if (ad === 'ts') {
    // Template literals : on garde les `${expr}`.
    c = c.replace(/`(?:[^`\\]|\\.)*`/g, keepTsHoles);
  }

  // Strings génériques (ne traversent pas les sauts de ligne).
  c = c.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  c = c.replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  return c;
}

// ---------------------------------------------------------------------------
// (1) Graphe d'imports et module déclarant — améliore la résolution par nom
// hors .NET. Sans types ni build, on ne peut pas prouver qu'un `save()` est
// CELUI qu'on cherche ; mais on peut savoir si le fichier IMPORTE bien le
// symbole (ou vit dans le même module) et pondérer la confiance en
// conséquence. Le comptage brut reste inchangé — on ne fait qu'annoter — pour
// zéro régression sur le score de risque.
// ---------------------------------------------------------------------------

// Extraction du nom court importé, par langage. Le dernier segment d'un `use`
// PHP / `import` Kotlin est le nom local ; en TS on lit les noms destructurés
// `{ A, B as C }` et l'import par défaut.
const IMPORT_RE = {
  php: /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm,
  kt: /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm,
  ts: /^\s*import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:from\s+)?['"][^'"]+['"]/gm,
};

// Noms courts importés dans le fichier. Sert de signal de confiance : une
// référence à `Order` dans un fichier qui importe explicitement `Order` est
// quasi certainement CE `Order` — ce qui départage les homonymes cross-module.
function importedNames(content, rel) {
  const ad = adapterFor(rel);
  const names = new Set();
  const reDef = IMPORT_RE[ad];
  if (!reDef) return names;
  reDef.lastIndex = 0;
  let m;
  while ((m = reDef.exec(content)) !== null) {
    if (ad === 'ts') {
      if (m[1]) names.add(m[1]);                       // import par défaut
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

// Chemin d'import COMPLET lié à un nom local (php/kt uniquement — en TS le
// spécifieur est un chemin de fichier, pas un chemin de symbole). Permet de
// départager deux homonymes : `use App\A\Order` vs `use App\B\Order` importent
// tous deux un `Order`, mais un seul pointe vers la déclaration cherchée.
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

// Module déclarant d'un fichier : namespace PHP, package Kotlin, namespace C#.
// En TS il n'y a pas de déclaration de module portable — on renvoie null et on
// se rabat sur le seul signal des imports par nom.
const _pkgRe = { php: /^\s*namespace\s+([\w\\]+)/m, kt: /^\s*package\s+([\w.]+)/m, cs: /^\s*namespace\s+([\w.]+)/m };
function moduleOf(content, rel) {
  const ad = adapterFor(rel);
  const re = _pkgRe[ad];
  if (!re) return null;
  const m = re.exec(content);
  return m ? m[1] : null;
}

// (2) Nature d'une référence d'après le token qui précède : appel membre
// (`->`, `.`), statique (`::`), instanciation (`new`/`instanceof`). Un site
// qualifié est un signal FORT que c'est un vrai symbole et pas un homonyme
// bare-word (variable locale, clé, mot-clé). Renvoie null si non qualifié.
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
 * Références à un symbole dans tout l'arbre. Retourne les sites d'appel
 * groupés par fichier, en excluant la ligne de déclaration elle-même.
 *
 * opts.ambiguous : le symbole a plusieurs déclarations homonymes (l'appelant
 *   le sait car il scanne toutes les déclarations). Active la rétrogradation
 *   de confiance des sites non importés / hors module.
 *
 * Chaque hit porte `confidence` ('high' | 'normal' | 'low') et `confident`
 * (nombre de lignes à site qualifié ou fichier important le symbole). Les
 * compteurs `count`/`occurrences` restent le comptage brut — additif, donc
 * aucune régression sur le score de risque existant.
 */
const LINES_SHOWN_MAX = 50;

function references(root, files, symbol, declFile, opts = {}) {
  const ambiguous = !!opts.ambiguous;
  // Frontière renforcée : `(?<![\w$])` rejette `$symbol` (variable PHP,
  // identifiant JS `$foo`) que le simple `\b` matchait à tort. Le `\b` final
  // suffit à droite. Node 18+ supporte le lookbehind.
  const re = new RegExp(`(?<![\\w$])${escapeRe(symbol)}\\b`, 'g');
  // Module du fichier déclarant : les sites du même module n'ont pas besoin
  // d'un import pour être fiables (usage intra-namespace/intra-package).
  const declRaw = declFile ? read(root, declFile) : null;
  const declModule = declRaw !== null ? moduleOf(declRaw, declFile) : null;
  const hits = [];
  for (const rel of files) {
    const raw = read(root, rel);
    if (raw === null) continue;
    if (!raw.includes(symbol)) continue; // filtre rapide avant le coûteux
    const content = stripNoise(raw, rel);
    const ad = adapterFor(rel);
    // Imports et module se lisent sur le code non nettoyé (lignes réelles).
    // On distingue trois cas via le chemin d'import COMPLET (php/kt) :
    //  - importHere      : importe exactement la déclaration cherchée => fort
    //  - importElsewhere : importe un homonyme d'un AUTRE module => ce fichier
    //    ne référence PAS notre symbole, quel que soit le nombre de matches
    //  - sinon : signal de nom seul (ts) ou même module.
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
    const lineSet = new Set();   // lignes distinctes, NON plafonnées : alimente le risque
    const shownLines = [];       // sous-ensemble borné, pour l'affichage seulement
    let occurrences = 0;         // total des correspondances (peut dépasser les lignes)
    let strong = false;          // au moins un site qualifié (->/::/new/.)
    let skippedDecl = false;
    let m;
    while ((m = re.exec(content)) !== null) {
      // On ignore une seule fois la ligne de déclaration elle-même.
      if (rel === declFile && !skippedDecl && isDeclLine(content, m.index)) { skippedDecl = true; continue; }
      // La ligne `use`/`import` n'est pas un site d'appel : elle a déjà servi
      // à calculer fileImports, la recompter gonflerait le périmètre.
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
      // Confiance : un fichier qui importe un homonyme d'un AUTRE module ne
      // référence pas notre symbole => low, même si les sites sont qualifiés
      // (ils appellent l'autre). Sinon : import exact / même module / site
      // qualifié = high ; homonyme ambigu sans signal = low ; défaut normal.
      let confidence = 'normal';
      if (importElsewhere) confidence = 'low';
      else if (fileImports || sameModule || strong) confidence = 'high';
      else if (ambiguous) confidence = 'low';
      hits.push({
        file: rel,
        lines: shownLines,               // affichage borné
        count: lineSet.size,             // lignes distinctes, NON plafonné
        occurrences,                     // total des correspondances
        truncated: lineSet.size > shownLines.length,  // liste d'affichage écourtée
        confidence,                      // 'high' | 'normal' | 'low'
        imported: fileImports,           // le fichier importe explicitement le symbole
      });
    }
  }
  // Tri : nombre de lignes d'abord (comportement historique inchangé), la
  // confiance ne sert que de départage à comptage égal — pas de réordonnancement
  // visible sur le chemin .NET déjà calibré.
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
 * Filtre les chemins fournis par git (qui ne passent pas par walk et
 * n'héritent donc pas des exclusions). Sans ça, `.impact/report.md` se
 * retrouve analysé comme du code source et le rapport s'auto-pollue.
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
