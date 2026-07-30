'use strict';

const BADGE = { low: 'LOW', moderate: 'MODERATE', high: 'HIGH', blocking: 'BLOCKING' };

function render(data) {
  const L = [];
  const p = s => L.push(s);

  p(`# Impact report — ${data.mode === 'diff' ? 'diff' : 'scope'}`);
  p('');
  p(`**Risk: ${BADGE[data.risk.level]}** — ${data.risk.reasons.join('; ')}`);
  p('');
  p(`Repo \`${data.repo}\` · branch \`${data.branch || '?'}\` · HEAD \`${(data.head || '').slice(0, 8)}\` · generated ${data.generatedAt}`);
  if (!data.configFound) {
    p('');
    p('> No `impact.config.json` in this repo: default thresholds and external consumers. Expect more false positives than after calibration.');
  }
  p('');

  // --- Symbols ---
  p('## Symbols analyzed');
  p('');
  if (!data.symbols.length) {
    p('_No symbol resolved._ The scope therefore rests only on historical coupling and the risk rules.');
  } else {
    p('| Symbol | Kind | Declared in | Call sites | Files |');
    p('|---|---|---|---|---|');
    for (const s of data.symbols) {
      p(`| \`${s.name}\` | ${s.kind || '?'} | ${s.declFile ? `\`${s.declFile}\`${s.declLine ? ':' + s.declLine : ''}` : '_not found_'} | ${s.callSites} | ${s.files} |`);
    }
    const ambig = data.symbols.filter(s => s.ambiguous);
    if (ambig.length) {
      p('');
      p('> **Ambiguous symbol(s).** Name-based search does not distinguish homonyms from different namespaces. The call sites above may mix several symbols:');
      for (const s of ambig) {
        p(`> - \`${s.name}\` — ${s.declCount} declarations${s.namespaces && s.namespaces.length ? ` (namespaces: ${s.namespaces.join(', ')})` : ''}`);
      }
    }
  }
  p('');

  // --- Callers ---
  if (data.topCallers.length) {
    p('## Callers — confidence: textual');
    p('');
    p('Name-based search over the source tree, comments and string literals stripped. A homonym in another namespace will show up here incorrectly.');
    p('');
    for (const c of data.topCallers.slice(0, 25)) {
      const occ = c.occurrences && c.occurrences > c.count ? ` · ${c.occurrences} occurrence(s)` : '';
      const trunc = c.truncated ? ` · line list truncated to ${c.lines.length}` : '';
      // Confidence marker: shown only when the match is not clear-cut (likely homonym).
      const conf = c.confidence && c.confidence !== 'high' ? ` (confidence: ${c.confidence})` : '';
      p(`- \`${c.file}\` — ${c.count} line(s)${occ}${c.lines.length ? ` (lines ${c.lines.slice(0, 8).join(', ')}${c.lines.length > 8 ? '…' : ''})` : ''}${trunc} · symbol \`${c.symbol}\`${conf}`);
    }
    if (data.topCallers.length > 25) p(`- … and ${data.topCallers.length - 25} more file(s)`);
    p('');
  }

  // --- Cross-repo ---
  if (data.crossRepo && data.crossRepo.length) {
    p('## Other workspace repos referencing these symbols');
    p('');
    p('Strong signal: a change here reaches beyond this repo.');
    p('');
    p('| Repo | Symbol | Files |');
    p('|---|---|---|');
    for (const r of data.crossRepo) p(`| \`${r.repo}\` | \`${r.symbol}\` | ${r.files} |`);
    p('');
  }
  if (data.externalConsumers && data.externalConsumers.length) {
    p('## Declared external consumers');
    p('');
    for (const c of data.externalConsumers) p(`- ${typeof c === 'string' ? c : `${c.name}${c.contact ? ` — contact: ${c.contact}` : ''}${c.consumes ? ` — consumes: ${c.consumes}` : ''}`}`);
    p('');
  }

  // --- Coupling ---
  if (data.coupling.length) {
    p('## Historical coupling — confidence: historical (deterministic)');
    p('');
    p('Files that change together with the target across git history. This catches what name analysis cannot see: reflection, convention-based DI, hardcoded SQL, docs and config.');
    p('');
    p('| File | Co-change | Via |');
    p('|---|---|---|');
    for (const c of data.coupling.slice(0, 20)) {
      p(`| \`${c.file}\` | ${c.commits}/${c.of} commits (${Math.round(c.ratio * 100)}%) | \`${c.via}\` |`);
    }
    p('');
  }

  // --- Public surface ---
  if (data.apiSurface.length) {
    p('## Public surface affected');
    p('');
    p('What may break someone outside this repo: mobile app, client, integration.');
    p('');
    for (const a of data.apiSurface) {
      p(`- **${a.label}** in \`${a.file}\` — ${a.samples.map(s => `\`${s}\``).join(', ')}`);
    }
    p('');
  }

  // --- Breaking API ---
  // Incompatible changes to the public surface: strong signal, placed right after the public surface.
  if (Array.isArray(data.apiBreaking) && data.apiBreaking.length) {
    p('### Breaking API changes');
    p('');
    p('Incompatible changes to the public surface. Any consumer relying on these will break at build or runtime.');
    p('');
    for (const b of data.apiBreaking) {
      const after = b.after ? `, after: \`${b.after}\`` : '';
      p(`- \`${b.file}\` — ${b.label}: \`${b.symbol}\` ${b.change} (before: \`${b.before}\`${after})`);
    }
    p('');
  }

  // --- Irreversible ---
  p('## Irreversible or side-effecting operations');
  p('');
  if (!data.irreversible.length) {
    p('None detected. This does not prove absence: a job configured in the database or a DBMS trigger stays invisible here.');
  } else {
    p('| Weight | Nature | Where | Evidence |');
    p('|---|---|---|---|');
    for (const f of data.irreversible) {
      p(`| ${f.weight} | ${f.label} | \`${f.where}\` | \`${f.evidence.replace(/\|/g, '\\|')}\` |`);
    }
    p('');
    p('**These are the only items a sandbox will not catch.** A passing test says nothing about an email already sent or a column already dropped in production.');
  }
  p('');

  // --- Tests ---
  p('## Tests to run first');
  p('');
  if (!data.tests.length) {
    p('No test identified. Either the scope is not covered — information in itself — or the test naming convention is not recognized (see `testPatterns` in the config).');
  } else {
    for (const t of data.tests) p(`- \`${t.file}\` — ${t.reasons.slice(0, 3).join('; ')} _(${t.confidence})_`);
    p('');
    p('The full suite is still required before merge. This list is for fast feedback, not a replacement for CI.');
  }
  p('');

  // --- Files ---
  if (data.changedFiles && data.changedFiles.length) {
    p('## Changed files');
    p('');
    for (const f of data.changedFiles.slice(0, 40)) p(`- \`${f}\``);
    if (data.changedFiles.length > 40) p(`- … and ${data.changedFiles.length - 40} more`);
    p('');
  }

  // --- Prior incidents (advisory) ---
  // Advisory history from seismo-memory: purely informational, does NOT enter the risk computation.
  if (Array.isArray(data.priorHints) && data.priorHints.length) {
    p('### Prior incidents (advisory)');
    p('');
    p('_Advisory / informational only._ Past incidents recorded for these targets. This does **not** affect the risk level above, which is computed deterministically from the analysis alone.');
    p('');
    for (const h of data.priorHints) {
      p(`- \`${h.target}\` — ${h.hint}`);
    }
    p('');
  }

  // --- Blind spots ---
  p('## Blind spots of this analysis');
  p('');
  p('Read this before trusting the report:');
  p('');
  p('- Reflection, dynamic activation, `Type.GetType`, convention-based DI containers');
  p('- Hardcoded SQL, views and stored procedures, DBMS triggers');
  p('- Jobs, business rules and feature flags configured in the database');
  p('- URLs and handler names built by concatenation');
  p('- View-side bindings (Razor, Blade, Compose) not named explicitly');
  p('');
  p('This report reduces upfront ignorance. It never replaces compiling then testing.');

  return L.join('\n') + '\n';
}

/** Short version, for the hook and the terminal. */
function renderShort(data) {
  const L = [];
  L.push(`Impact ${BADGE[data.risk.level]} — ${data.risk.reasons.join('; ')}`);
  L.push(`Symbols: ${data.symbols.map(s => s.name).join(', ') || '(none)'}`);
  L.push(`Callers: ${data.summary.callers} sites in ${data.topCallers.length} file(s)`);
  if (data.coupling.length) L.push(`Historical coupling: ${data.coupling.slice(0, 5).map(c => c.file).join(', ')}`);
  if (data.irreversible.length) {
    const labels = [...new Set(data.irreversible.map(f => f.label))];
    L.push(`Irreversible: ${labels.join('; ')}`);
  }
  if (data.crossRepo && data.crossRepo.length) L.push(`Cross-repo: ${[...new Set(data.crossRepo.map(r => r.repo))].join(', ')}`);
  if (Array.isArray(data.apiBreaking) && data.apiBreaking.length) L.push(`Breaking API changes: ${data.apiBreaking.length}`);
  // Advisory only: does not influence the risk.
  if (Array.isArray(data.priorHints) && data.priorHints.length) L.push(`Prior incidents (advisory): ${data.priorHints.length}`);
  L.push(`Priority tests: ${data.tests.length}`);
  return L.join('\n');
}

module.exports = { render, renderShort };
