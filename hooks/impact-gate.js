#!/usr/bin/env node
'use strict';
/**
 * PreToolUse hook for Claude Code.
 *
 * Purpose: prevent the agent from modifying a file before it has looked at the
 * scope. This is the "the agent is prevented" part — without it, the skill is
 * just a suggestion the agent will ignore the moment it is in a hurry.
 *
 * Claude Code contract (reference: https://code.claude.com/docs/en/hooks):
 *   - the tool call's JSON on stdin
 *   - exit 0  : the call goes through
 *   - exit 2  : the call is blocked, stderr is sent back to the model
 * The JSON variant `hookSpecificOutput.permissionDecision: "deny"` on exit 0
 * also exists, but exit 2 is the most stable path for Edit/Write.
 *
 * Installation in .claude/settings.json:
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

// Gate mode is read from the target repo's impact.config.json (default
// 'advisory'). Loaded lazily and defensively — a broken or missing config must
// never make the hook throw.
function gateMode(root) {
  try {
    const cfg = require('../lib/config').load(root);
    return cfg.gate || 'advisory';
  } catch {
    return 'advisory';
  }
}

// Guarded extensions. Touching a README does not warrant a guard: a gate that
// fires on everything is a gate the team turns off.
const GUARDED = ['.cs', '.php', '.kt', '.kts', '.ts', '.tsx', '.sql', '.razor', '.cshtml'];

// Paths that are never guarded, even with a watched extension.
const SKIP = [/\.impact\//, /[\/\\](obj|bin|node_modules|vendor)[\/\\]/, /Tests?[\/\\]/];

let raw = '';
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const cwd = input.cwd || process.cwd();
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.path || (Array.isArray(ti.edits) && ti.edits[0] && ti.edits[0].file_path);

  // No identifiable file, or file out of scope: we let it through.
  // A guard that blocks by default on the unknown is a guard that gets disabled
  // within a day.
  if (!target) process.exit(0);
  if (!GUARDED.some(e => target.endsWith(e))) process.exit(0);
  if (SKIP.some(re => re.test(target))) process.exit(0);

  // Creating a brand-new file: nothing upstream to break.
  if (!fs.existsSync(target)) process.exit(0);

  const mode = gateMode(cwd);
  if (mode === 'off') process.exit(0);

  const cli = path.join(__dirname, '..', 'bin', 'impact.js');
  try {
    execFileSync(process.execPath, [cli, 'gate', '--root', cwd, '--file', target], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    });
    process.exit(0);
  } catch (e) {
    const reason = (e.stderr || e.stdout || e.message || '').trim();

    // Advisory (default): surface the missing/stale coverage but DO NOT block.
    // A gate that refuses every edit until a fresh report exists is a gate the
    // team disables within a week — so the default informs instead of stopping.
    if (mode !== 'blocking') {
      process.stderr.write(
`impact advisory — no fresh analysis covers this file (edit not blocked).
${reason}
Consider running the impact analysis if this change is non-trivial. Set "gate": "blocking" in impact.config.json to enforce.
`);
      process.exit(0);
    }

    // Blocking mode: refuse the edit. Wording matters — a hook block is often
    // read as a user refusal, and the agent stops instead of fixing. Make it
    // explicit this is automatic.
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
