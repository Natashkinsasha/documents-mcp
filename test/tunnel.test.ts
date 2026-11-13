import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TunnelSupervisor } from '../src/tunnel.js';
import { tempProject } from './helpers.js';

test('fake tunnel receives token only via env, redacts logs, backs off and stops', async (context) => {
  const fixture = await tempProject('tunnel'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const binary = path.join(fixture.directory, 'cloudflared.cjs'); const capture = path.join(fixture.directory, 'calls.jsonl');
  await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({time:Date.now(),args:process.argv.slice(2),token:process.env.TUNNEL_TOKEN,mcp:process.env.MCP_TOKEN})+'\\n');console.log('token='+process.env.TUNNEL_TOKEN);setTimeout(()=>process.exit(1),10);\n`);
  await chmod(binary, 0o700);
  const logs: Record<string, unknown>[] = [];
  const supervisor = new TunnelSupervisor(binary, 'fake-secret-token', (entry) => logs.push(entry), 40, 160);
  context.after(() => supervisor.stop()); supervisor.start();
  const end = Date.now() + 5000;
  let calls: { time: number; args: string[]; token: string; mcp?: string }[] = [];
  while (Date.now() < end) {
    calls = (await readFile(capture, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (calls.length >= 3) break;
    await delay(20);
  }
  await supervisor.stop(); assert.ok(calls.length >= 3);
  for (const call of calls) { assert.deepEqual(call.args, ['tunnel', '--no-autoupdate', 'run']); assert.equal(call.token, 'fake-secret-token'); assert.equal(call.mcp, undefined); }
  assert.ok(calls[1]!.time - calls[0]!.time >= 40); assert.ok(calls[2]!.time - calls[1]!.time >= 80);
  assert.deepEqual(logs.filter((entry) => entry.delay_ms).slice(0, 2).map((entry) => entry.delay_ms), [40, 80]);
  assert.ok(!JSON.stringify(logs).includes('fake-secret-token')); assert.ok(JSON.stringify(logs).includes('[tunnel]'));
  const after = await readFile(capture, 'utf8'); await delay(250); assert.equal(await readFile(capture, 'utf8'), after);
});
