#!/usr/bin/env node
'use strict';
/**
 * Hook PreToolUse pour Claude Code.
 *
 * Rôle : empêcher l'agent de modifier un fichier avant d'avoir regardé le
 * périmètre. C'est la partie « l'agent est empêché » — sans elle, le skill est
 * une suggestion que l'agent ignorera dès qu'il sera pressé.
 *
 * Contrat Claude Code (référence : https://code.claude.com/docs/en/hooks) :
 *   - JSON de l'appel d'outil sur stdin
 *   - exit 0  : l'appel passe
 *   - exit 2  : l'appel est bloqué, stderr est renvoyé au modèle
 * La variante JSON `hookSpecificOutput.permissionDecision: "deny"` en exit 0
 * existe aussi, mais exit 2 est le chemin le plus stable pour Edit/Write.
 *
 * Installation dans .claude/settings.json :
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "Edit|Write|MultiEdit",
 *         "hooks": [{ "type": "command", "command": "node .claude/tools/seismo-cc/hooks/impact-gate.js" }]
 *       }]
 *     }
 *   }
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Extensions gardées. Toucher un README ne mérite pas un garde-fou : le gate
// qui se déclenche sur tout est un gate que l'équipe désactive.
const GUARDED = ['.cs', '.php', '.kt', '.kts', '.ts', '.tsx', '.sql', '.razor', '.cshtml'];

// Chemins jamais gardés, même avec une extension surveillée.
const SKIP = [/\.impact\//, /[\/\\](obj|bin|node_modules|vendor)[\/\\]/, /Tests?[\/\\]/];

let raw = '';
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const cwd = input.cwd || process.cwd();
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.path || (Array.isArray(ti.edits) && ti.edits[0] && ti.edits[0].file_path);

  // Pas de fichier identifiable, ou fichier hors périmètre : on laisse passer.
  // Un garde-fou qui bloque par défaut sur l'inconnu est un garde-fou désactivé
  // au bout d'une journée.
  if (!target) process.exit(0);
  if (!GUARDED.some(e => target.endsWith(e))) process.exit(0);
  if (SKIP.some(re => re.test(target))) process.exit(0);

  // Création d'un fichier neuf : rien à casser en amont.
  if (!fs.existsSync(target)) process.exit(0);

  const cli = path.join(__dirname, '..', 'bin', 'impact.js');
  try {
    execFileSync(process.execPath, [cli, 'gate', '--root', cwd, '--file', target], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    });
    process.exit(0);
  } catch (e) {
    const reason = (e.stderr || e.stdout || e.message || '').trim();
    // Wording matters: a hook block is often read as a user refusal, and the
    // agent stops instead of fixing. Make it explicit this is automatic.
    process.stderr.write(
`AUTOMATIC GUARD — impact analysis missing or insufficient.
This is not a user refusal. Continue your work autonomously.

${reason}

Expected steps:
1. Run the impact analysis on the targeted file.
2. Read .impact/report.md and summarize the scope to the user.
3. If the risk is BLOCKING or consumer repos are affected, ask for validation before modifying.
4. Otherwise, retry the same modification.
`);
    process.exit(2);
  }
});
