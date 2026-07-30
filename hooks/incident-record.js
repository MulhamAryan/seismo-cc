#!/usr/bin/env node
'use strict';
/**
 * seismo-memory POST-incident hook — feeds the store from revert commits.
 * This is NOT a Claude Code hook (incidents happen in ops/deploy, not during
 * editing): it is a post-merge git hook or a CI step. It runs OUTSIDE the
 * read-only analysis path, so there is no loop with the gate.
 *
 * Git wiring (in the target repo, .git/hooks/post-merge):
 *   #!/bin/sh
 *   node "$CLAUDE_PLUGIN_ROOT/hooks/incident-record.js"
 *
 * Or in CI, after a rollback/deployment:
 *   node <plugin>/hooks/incident-record.js
 *
 * Variables: SEISMO_ROOT (repo root, default cwd), SEISMO_REVERT_DEPTH
 * (history depth, default 200). Silent no-op if memoryPath is not configured
 * or outside a git repo. NEVER blocking: always exits 0.
 */
const engine = require('../lib/analyze');
const config = require('../lib/config');

const root = process.env.SEISMO_ROOT || process.cwd();
try {
  const cfg = config.load(root);
  const depth = Number(process.env.SEISMO_REVERT_DEPTH) > 0 ? Number(process.env.SEISMO_REVERT_DEPTH) : 200;
  const { added, reverts } = engine.recordFromReverts(cfg, root, depth);
  // Diagnostics on stderr only (a hook must not pollute stdout).
  if (added) process.stderr.write(`[seismo-cc] seismo-memory: ${added} incident(s) recorded from ${reverts} revert commit(s)\n`);
} catch {
  // A history hook must never break a merge or a pipeline.
}
process.exit(0);
