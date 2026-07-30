'use strict';
const { IRREVERSIBLE, API_SURFACE } = require('./config');
const scan = require('./scan');

/**
 * Opérations irréversibles détectées. On les cherche dans le contenu des
 * fichiers concernés ET dans le texte du diff, parce qu'une ligne supprimée
 * compte autant qu'une ligne ajoutée quand il s'agit d'un DROP COLUMN.
 */
function irreversible(root, files, diff) {
  const findings = [];
  const seen = new Set();

  const push = (rule, where, evidence) => {
    const key = `${rule.id}|${where}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ id: rule.id, label: rule.label, weight: rule.weight, where, evidence: evidence.slice(0, 160).trim() });
  };

  for (const rel of files) {
    for (const rule of IRREVERSIBLE) {
      if (rule.re.test(rel)) push(rule, rel, `chemin : ${rel}`);
    }
    const content = scan.read(root, rel);
    if (content === null) continue;
    const clean = scan.stripNoise(content, rel);
    for (const rule of IRREVERSIBLE) {
      const re = new RegExp(rule.re.source, 'i');
      const m = re.exec(clean);
      if (m) push(rule, rel, m[0]);
    }
  }

  if (diff) {
    const alreadyInFile = new Set(findings.map(f => f.id));
    for (const line of diff.split('\n')) {
      if (!/^[+-]/.test(line) || /^[+-]{3}/.test(line)) continue;
      // Ne pas répéter une règle déjà attribuée à un fichier concret :
      // trois lignes pour le même DropColumn rend le rapport illisible.
      for (const rule of IRREVERSIBLE) {
        if (alreadyInFile.has(rule.id)) continue;
        const re = new RegExp(rule.re.source, 'i');
        if (re.test(line)) push(rule, 'diff', line);
      }
    }
  }

  return findings.sort((a, b) => b.weight - a.weight);
}

/**
 * Surface publique touchée : ce qui casse un consommateur hors du repo.
 * Le graphe interne ne voit pas les consommateurs externes du repo.
 */
function apiSurface(root, files) {
  const findings = [];
  for (const rel of files) {
    const content = scan.read(root, rel);
    if (content === null) continue;
    const clean = scan.stripNoise(content, rel);
    findings.push(...apiSurfaceOfContent(clean, rel));
  }
  return findings;
}

/**
 * Surface publique d'UN contenu déjà nettoyé (stripNoise). Isolé de apiSurface
 * pour pouvoir l'appliquer à une version antérieure d'un fichier (issue de
 * `git show base:file`) et calculer un diff avant/après de l'API — ce que le
 * disque seul ne permet pas.
 */
function apiSurfaceOfContent(clean, rel) {
  const findings = [];
  for (const rule of API_SURFACE) {
    const re = new RegExp(rule.re.source, 'g');
    const matches = [...clean.matchAll(re)].slice(0, 12);
    if (matches.length) {
      findings.push({
        id: rule.id,
        label: rule.label,
        file: rel,
        samples: [...new Set(matches.map(m => m[0].trim()))].slice(0, 6),
        count: matches.length,
      });
    }
  }
  return findings;
}

/**
 * Tests concernés : ceux qui référencent un des symboles, plus ceux
 * historiquement couplés. Le second lot rattrape les tests d'intégration
 * qui ne nomment jamais le symbole.
 */
function affectedTests(cfg, refsBySymbol, couplingList) {
  const tests = new Map();
  for (const [symbol, refs] of Object.entries(refsBySymbol)) {
    for (const r of refs) {
      if (!scan.isTest(r.file, cfg)) continue;
      const e = tests.get(r.file) || { file: r.file, reasons: [], confidence: 'structural' };
      e.reasons.push(`references ${symbol}`);
      tests.set(r.file, e);
    }
  }
  for (const c of couplingList) {
    if (!scan.isTest(c.file, cfg)) continue;
    const e = tests.get(c.file) || { file: c.file, reasons: [], confidence: 'historical' };
    e.reasons.push(`co-changed ${Math.round(c.ratio * 100)}% with ${c.via}`);
    tests.set(c.file, e);
  }
  return [...tests.values()];
}

/**
 * Niveau de risque. Délibérément simple et lisible : un score opaque n'est
 * pas actionnable, et personne ne fait confiance à un chiffre qu'il ne peut
 * pas reconstituer de tête.
 */
function riskLevel(cfg, summary) {
  const t = cfg.thresholds;
  const reasons = [];
  let level = 'low';

  const worst = summary.irreversible.reduce((a, f) => Math.max(a, f.weight), 0);
  if (worst >= 5) { level = 'blocking'; reasons.push('high-impact irreversible operation detected'); }
  else if (worst >= 3) { level = 'high'; reasons.push('non-reversible side-effect operation detected'); }

  if (summary.callers >= t.callersHigh) {
    if (level !== 'blocking') level = 'high';
    reasons.push(`${summary.callers} call sites affected`);
  } else if (summary.callers >= t.callersWarn) {
    if (level === 'low') level = 'moderate';
    reasons.push(`${summary.callers} call sites affected`);
  }

  if (summary.apiSurface > 0) {
    if (level === 'low') level = 'moderate';
    reasons.push(`${summary.apiSurface} public-surface element(s) affected`);
  }

  if (summary.crossRepo > 0) {
    level = level === 'blocking' ? 'blocking' : 'high';
    reasons.push(`${summary.crossRepo} consumer repo(s) reference the modified symbols`);
  }

  if (summary.externalConsumers > 0 && summary.apiSurface > 0) {
    level = 'blocking';
    reasons.push('declared external consumer + public surface modified');
  }

  if (!reasons.length) reasons.push('no notable signal');
  return { level, reasons };
}

module.exports = { irreversible, apiSurface, apiSurfaceOfContent, affectedTests, riskLevel };
