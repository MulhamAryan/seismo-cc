#!/usr/bin/env node
'use strict';
/**
 * Serveur MCP eonix-impact — transport stdio JSON-RPC 2.0, ZÉRO dépendance.
 *
 * Expose 4 tools qui appellent le MÊME lib/analyze.js que la CLI. SEUL
 * `get_blast_radius` — le tool qui définit le périmètre AVANT une édition —
 * persiste .impact/latest.json et nourrit ainsi le gate PreToolUse. Les trois
 * autres sont des requêtes advisory (tests, diff d'API, opérations
 * irréversibles) : elles calculent et renvoient SANS écraser la couverture,
 * sinon un appel à scope réduit effacerait le périmètre que blast_radius vient
 * d'établir et le gate bloquerait un fichier pourtant analysé.
 * L'agent interroge (advisory) ; le hook exécute (déterministe). MCP ne
 * remplace pas le gate, il le nourrit.
 *
 * stdout est RÉSERVÉ au protocole (messages JSON-RPC ligne par ligne). Tout
 * diagnostic va sur stderr. lib/analyze.js n'écrit jamais sur stdout et git
 * tourne en pipe capturé, donc la sortie reste propre.
 */
const engine = require('../../../lib/analyze');

const PROTOCOL = '2024-11-05';
const SERVER = { name: 'eonix-impact', version: '0.1.0' };
const REPORT = '.impact/report.md';

// --- Les 4 tools : schéma d'entrée + implémentation (slice de engine.run). ---
// Chaque `run` appelle engine.run() puis engine.persist() — l'écriture de
// l'artefact est ce qui rend l'analyse opposable au gate.
const TOOLS = [
  {
    name: 'get_blast_radius',
    description:
      "Périmètre d'impact d'un symbole ou d'un fichier : appelants (call sites), couplage historique git, consommateurs cross-repo, niveau de risque. Écrit .impact/latest.json (nourrit le gate PreToolUse).",
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: 'noms de symboles (types, méthodes)' },
        files: { type: 'array', items: { type: 'string' }, description: 'fichiers dont on infère les symboles à défaut' },
        root: { type: 'string', description: 'racine du repo (défaut : cwd)' },
      },
    },
    run(a) {
      const d = engine.run({ root: a.root, symbols: a.symbols, files: a.files });
      engine.persist(d.root, d);
      return {
        risk: d.risk,
        callers: d.summary.callers,
        symbols: d.symbols,
        topCallers: d.topCallers.slice(0, 20),
        coupling: d.coupling,
        crossRepo: d.crossRepo,
        externalConsumers: d.externalConsumers,
        priorHints: d.priorHints,
        reportPath: REPORT,
      };
    },
  },
  {
    name: 'get_affected_tests',
    description:
      'Tests concernés par un diff ou des fichiers : structuraux (référencent le symbole modifié) + historiques (co-changés en git). Requête advisory : n\'écrase pas .impact/latest.json.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'boolean', description: 'analyser le diff courant' },
        base: { type: 'string', description: 'branche/ref de base (défaut : origin/main)' },
        files: { type: 'array', items: { type: 'string' } },
        root: { type: 'string' },
      },
    },
    run(a) {
      const d = engine.run({ root: a.root, diff: !!a.diff, base: a.base, files: a.files });
      return { tests: d.tests, count: d.tests.length };
    },
  },
  {
    name: 'get_public_api_diff',
    description:
      'Diff avant/après de la surface publique entre la branche courante et une base : `breaking` liste les éléments publics retirés ou dont la signature change (endpoints ASP.NET/FastEndpoints/Minimal API, contrats) ; `publicSurface` liste la surface touchée. Requête advisory : n\'écrase pas .impact/latest.json.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'branche/ref de base à comparer' },
        root: { type: 'string' },
      },
      required: ['base'],
    },
    run(a) {
      const d = engine.run({ root: a.root, diff: true, base: a.base });
      return { publicSurface: d.apiSurface, breaking: d.apiBreaking || [] };
    },
  },
  {
    name: 'get_irreversible_ops',
    description:
      'Opérations non annulables dans un diff : DROP COLUMN, migrations destructives, effets de bord (mails, paiements, jobs). Renvoie aussi le seuil de gate correspondant. Requête advisory : n\'écrase pas .impact/latest.json.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'boolean' },
        base: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        root: { type: 'string' },
      },
    },
    run(a) {
      const d = engine.run({ root: a.root, diff: !!a.diff, base: a.base, files: a.files });
      const worst = d.irreversible.reduce((m, f) => Math.max(m, f.weight), 0);
      return {
        irreversible: d.irreversible,
        gate: worst >= 5 ? 'blocking' : worst >= 3 ? 'high' : 'none',
      };
    },
  },
];
const BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

// --- Boucle JSON-RPC 2.0 sur stdio (messages délimités par des sauts de ligne). ---
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;

  // Notifications : pas d'`id`, aucune réponse attendue.
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'initialize') {
    // On renvoie la version demandée par le client si fournie, pour maximiser
    // la compatibilité ; sinon notre version supportée.
    return ok(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }

  if (method === 'ping') return ok(id, {});

  if (method === 'tools/list') {
    return ok(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = BY_NAME[name];
    if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
    try {
      const out = tool.run((params && params.arguments) || {});
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      // Erreur applicative (repo non git, symbole absent…) : renvoyée comme
      // résultat `isError` et non erreur de protocole, pour que l'agent lise
      // le message plutôt que de recevoir une panne de transport.
      return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
    }
  }

  // Méthode inconnue avec id : erreur standard. Notification inconnue : ignorée.
  if (id !== undefined && id !== null) rpcError(id, -32601, `method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ligne non-JSON : ignorée, jamais fatale
    }
    handle(msg);
  }
});
// stdin fermé anormalement : ne pas jeter d'exception non capturée.
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
