import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxEnv } from '../testlib/os-sandbox.mjs';

const home = mkdtempSync(join(tmpdir(), 'preload-context-'));
const script = fileURLToPath(new URL('./session-preload.mjs', import.meta.url));
const context = '# Organization\nKeep credentials private.';
const native = (text) => `<!-- >>> lively-managed org-context (generated) >>> -->\n${text}\n<!-- <<< lively-managed <<< -->\nPersonal rules stay here.`;
try {
  mkdirSync(join(home, '.lively'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.lively/context.md'), context);
  const env = { ...sandboxEnv({ home, tmp: home }), LIVELY_TOKEN: '', CLAUDE_PLUGIN_OPTION_TOKEN: '', LIVELY_OFF: '', LIVELY_HOOKS_OFF: '', LIVELY_MODE: '', LIVELY_HARNESS: '', CODEX_HOME: join(home, '.codex') };
  const run = (harness = 'codex', extra = {}) => execFileSync(process.execPath, [script, '--harness', harness], { env: { ...env, ...extra }, cwd: home, encoding: 'utf8' });
  assert.equal(JSON.parse(run()).hookSpecificOutput.additionalContext, context, 'missing native file keeps context');
  writeFileSync(join(home, '.codex/AGENTS.md'), native(context));
  assert.equal(run(), '', 'exact native context is not injected twice');
  assert.match(run('claude'), /Keep credentials private/, 'Claude still receives context');
  assert.match(run('codex', { LIVELY_MODE: 'readonly' }), /read-only/, 'read-only banner survives dedup');
  writeFileSync(join(home, '.codex/AGENTS.md'), native('# Organization\nOutdated rule.'));
  assert.equal(JSON.parse(run()).hookSpecificOutput.additionalContext, context, 'fresh rules survive a stale native file');
  writeFileSync(join(home, '.codex/AGENTS.md'), native(context));
  writeFileSync(join(home, '.codex/AGENTS.override.md'), 'Override');
  assert.equal(JSON.parse(run()).hookSpecificOutput.additionalContext, context, 'override prevents assuming native AGENTS was loaded');
  rmSync(join(home, '.codex/AGENTS.override.md'));
  assert.equal(JSON.parse(run('codex', { CODEX_HOME: join(home, 'alternate') })).hookSpecificOutput.additionalContext, context, 'custom Codex home is respected');
  assert.equal(run('codex', { LIVELY_OFF: '1' }), '', 'incognito stays silent');
  console.log('PASS: native dedup, stale/missing/override fallback, custom home, Claude, readonly, incognito');
} finally { rmSync(home, { recursive: true, force: true }); }
