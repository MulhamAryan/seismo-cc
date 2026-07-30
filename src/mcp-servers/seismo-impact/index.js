#!/usr/bin/env node
'use strict';
/**
 * seismo-impact MCP server — stdio JSON-RPC 2.0 transport, ZERO dependencies.
 *
 * Exposes 4 tools that call the SAME lib/analyze.js as the CLI. ONLY
 * `get_blast_radius` — the tool that defines the scope BEFORE an edit —
 * persists .impact/latest.json and thereby feeds the PreToolUse gate. The
 * other three are advisory queries (tests, API diff, irreversible operations):
 * they compute and return WITHOUT overwriting the coverage, otherwise a
 * narrower-scoped call would wipe out the scope blast_radius just established
 * and the gate would block a file that was in fact analyzed.
 * The agent queries (advisory); the hook enforces (deterministic). MCP does
 * not replace the gate, it feeds it.
 *
 * stdout is RESERVED for the protocol (line-by-line JSON-RPC messages). All
 * diagnostics go to stderr. lib/analyze.js never writes to stdout and git runs
 * in a captured pipe, so the output stays clean.
 */
const engine = require('../../../lib/analyze');

const PROTOCOL = '2024-11-05';
const SERVER = { name: 'seismo-impact', version: '0.1.0' };
const REPORT = '.impact/report.md';

// --- The 4 tools: input schema + implementation (slice of engine.run). ---
// Each `run` calls engine.run() then engine.persist() — writing the artifact
// is what makes the analysis enforceable by the gate.
const TOOLS = [
  {
    name: 'get_blast_radius',
    description:
      "Impact scope of a symbol or a file: callers (call sites), git historical coupling, cross-repo consumers, risk level. Writes .impact/latest.json (feeds the PreToolUse gate).",
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: 'symbol names (types, methods)' },
        files: { type: 'array', items: { type: 'string' }, description: 'files whose symbols are inferred when none are given' },
        root: { type: 'string', description: 'repo root (default: cwd)' },
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
      'Tests affected by a diff or files: structural (reference the modified symbol) + historical (co-changed in git). Advisory query: does not overwrite .impact/latest.json.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'boolean', description: 'analyze the current diff' },
        base: { type: 'string', description: 'base branch/ref (default: origin/main)' },
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
      'Before/after diff of the public surface between the current branch and a base: `breaking` lists public elements removed or whose signature changes (ASP.NET/FastEndpoints/Minimal API endpoints, contracts); `publicSurface` lists the affected surface. Advisory query: does not overwrite .impact/latest.json.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'base branch/ref to compare against' },
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
      'Non-undoable operations in a diff: DROP COLUMN, destructive migrations, side effects (emails, payments, jobs). Also returns the corresponding gate threshold. Advisory query: does not overwrite .impact/latest.json.',
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

// --- JSON-RPC 2.0 loop over stdio (newline-delimited messages). ---
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

  // Notifications: no `id`, no response expected.
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'initialize') {
    // We return the version requested by the client if provided, to maximize
    // compatibility; otherwise our supported version.
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
      // Application error (not a git repo, missing symbol…): returned as an
      // `isError` result rather than a protocol error, so the agent reads the
      // message instead of getting a transport failure.
      return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
    }
  }

  // Unknown method with id: standard error. Unknown notification: ignored.
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
      continue; // non-JSON line: ignored, never fatal
    }
    handle(msg);
  }
});
// stdin closed abnormally: do not throw an uncaught exception.
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
