'use strict';
const { IRREVERSIBLE, API_SURFACE } = require('./config');
const scan = require('./scan');

/**
 * Irreversible operations detected. We look for them in the content of the
 * files concerned AND in the diff text, because a removed line counts as much
 * as an added line when it comes to a DROP COLUMN.
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
      if (rule.re.test(rel)) push(rule, rel, `path: ${rel}`);
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
      // Do not repeat a rule already attributed to a concrete file:
      // three lines for the same DropColumn makes the report unreadable.
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
 * Public surface affected: what breaks a consumer outside the repo.
 * The internal graph does not see the repo's external consumers.
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
 * Public surface of ONE already-cleaned content (stripNoise). Isolated from
 * apiSurface so it can be applied to an earlier version of a file (from
 * `git show base:file`) and compute a before/after diff of the API — which the
 * disk alone does not allow.
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
 * Tests concerned: those that reference one of the symbols, plus those
 * historically coupled. The second batch catches integration tests that
 * never name the symbol.
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
 * Risk level. Deliberately simple and readable: an opaque score is not
 * actionable, and nobody trusts a number they cannot reconstruct in their
 * head.
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
