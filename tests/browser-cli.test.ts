import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';

test('CLI rejects malformed batches before connecting to a role daemon', async () => {
  for (const source of [
    '[]',
    '[{"command":"fill","ref":"abc-1-1"}]',
    '[{"command":"submit","ref":"abc-1-2","value":"extra"}]',
    '[{"command":"click","ref":"abc-1-1","unexpected":true}]',
    'not-json'
  ]) await assert.rejects(cli('/does-not-exist', ['player-1', 'batch', source]));
});

async function cli(configRoot: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/browser.mjs'), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, FCTP_BROWSER_CONFIG_ROOT: configRoot },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`browser CLI exited ${code}: ${stderr.trim()}`));
      else resolveOutput(stdout);
    });
  });
}
