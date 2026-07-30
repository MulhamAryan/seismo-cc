#!/usr/bin/env node
'use strict';
/**
 * Hook POST-incident d'eonix-memory — alimente le store à partir des commits
 * de revert. Ce n'est PAS un hook Claude Code (les incidents surviennent en
 * ops/deploy, pas pendant l'édition) : c'est un hook git post-merge ou une
 * étape CI. Il tourne HORS du chemin d'analyse read-only, donc aucune boucle
 * avec le gate.
 *
 * Câblage git (dans le repo cible, .git/hooks/post-merge) :
 *   #!/bin/sh
 *   node "$CLAUDE_PLUGIN_ROOT/hooks/incident-record.js"
 *
 * Ou en CI, après un rollback/déploiement :
 *   node <plugin>/hooks/incident-record.js
 *
 * Variables : SEISMO_ROOT (racine du repo, défaut cwd), SEISMO_REVERT_DEPTH
 * (profondeur d'historique, défaut 200). No-op silencieux si memoryPath n'est
 * pas configuré ou hors repo git. JAMAIS bloquant : sort toujours en 0.
 */
const engine = require('../lib/analyze');
const config = require('../lib/config');

const root = process.env.SEISMO_ROOT || process.cwd();
try {
  const cfg = config.load(root);
  const depth = Number(process.env.SEISMO_REVERT_DEPTH) > 0 ? Number(process.env.SEISMO_REVERT_DEPTH) : 200;
  const { added, reverts } = engine.recordFromReverts(cfg, root, depth);
  // Diagnostic sur stderr uniquement (un hook ne doit pas polluer stdout).
  if (added) process.stderr.write(`[seismo-cc] eonix-memory: ${added} incident(s) recorded from ${reverts} revert commit(s)\n`);
} catch {
  // Un hook d'historique ne doit jamais casser un merge ou un pipeline.
}
process.exit(0);
