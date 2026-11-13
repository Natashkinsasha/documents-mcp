import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { install, type InstallDependencies } from '../src/install.js';
import { loadConfig, readConfigFile, serializeConfig } from '../src/config.js';
import { connectionOptions } from '../src/connection.js';

test('Cue install writes the returned port/token, prints the address/key, and preserves key through upgrade/reconnect', async (context) => {
  await mkdir('.cache', { recursive: true });
  const directory = await mkdtemp(path.resolve('.cache/install-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const docs = path.join(directory, 'docs'); await mkdir(docs);
  const paths = { binary: path.join(directory, 'program'), data: path.join(directory, 'data'), config: path.join(directory, 'config.env'), service: path.join(directory, 'service') };
  const output: string[] = []; const questions: string[] = []; const answers = ['1', 'https://vs.cuechat.org/mcp', 'ABCD-EFGH-JKMN'];
  const health: string[] = []; let claims = 0;
  const dependencies: Partial<InstallDependencies> = {
    platform: 'linux', sea: true, paths, administrator: async () => {},
    io: { print: (line) => output.push(line), ask: async (question, secret) => { questions.push(question); if (question.includes('Одноразовый')) assert.equal(secret, true); return answers.shift() ?? ''; } },
    claim: async (host, code) => { claims++; assert.equal(code, 'ABCD-EFGH-JKMN'); return { tunnelToken: `tunnel-secret-${claims}`, publicUrl: `https://${host}`, port: 4321 + claims }; },
    deploy: async (settings, options) => {
      assert.equal(options.cueCode, undefined); assert.equal(options.cueAddress, undefined);
      await loadConfig(settings); await writeFile(paths.config, serializeConfig(settings), { mode: 0o600 });
    },
    health: async (url) => { health.push(url); return !url.startsWith('https:'); },
  };
  const first = await install({ docs, port: '9000' }, dependencies);
  assert.equal(first.PORT, '4322'); assert.equal(first.TUNNEL_TOKEN, 'tunnel-secret-1'); assert.equal(first.PUBLIC_URL, 'https://vs.cuechat.org');
  assert.match(first.MCP_TOKEN!, /^[a-f0-9]{64}$/u); assert.equal(questions.length, 3);
  assert.deepEqual(health, ['http://127.0.0.1:4322/healthz', 'https://vs.cuechat.org/healthz']);
  assert.match(output.join('\n'), /Предупреждение/u); assert.ok(!output.join('\n').includes('Туннель работает'));
  assert.ok(output.join('\n').includes(`Ключ для Cue: ${first.MCP_TOKEN}`)); assert.ok(!output.join('\n').includes('tunnel-secret')); assert.ok(!output.join('\n').includes('ABCD-EFGH-JKMN'));
  assert.ok(!((await readFile(paths.config, 'utf8')).includes('ABCD-EFGH-JKMN')));
  assert.deepEqual(await readConfigFile(paths.config), first);
  const second = await install({ yes: true }, dependencies);
  assert.deepEqual(second, first); assert.equal(claims, 1);
  const third = await install({ yes: true, cueAddress: 'new.cuechat.org', cueCode: 'ABCD-EFGH-JKMN' }, dependencies);
  assert.equal(third.MCP_TOKEN, first.MCP_TOKEN); assert.equal(third.DOCS_ROOT, docs); assert.equal(third.PUBLIC_URL, 'https://new.cuechat.org'); assert.equal(third.PORT, '4323'); assert.equal(claims, 2);
  await install({}, dependencies);
  assert.equal(claims, 2); assert.equal((await readConfigFile(paths.config)).TUNNEL_TOKEN, third.TUNNEL_TOKEN);
  answers.push('3');
  const local = await install({}, dependencies);
  assert.equal(local.TUNNEL_TOKEN, ''); assert.equal(local.PUBLIC_URL, ''); assert.equal(local.MCP_TOKEN, first.MCP_TOKEN);
});

test('connection options validate Cue flags before claiming and reject mixed connection methods', async () => {
  let claims = 0;
  const claim = async () => { claims++; return { tunnelToken: 'secret', publicUrl: 'https://vs.cuechat.org', port: 3000 }; };
  for (const options of [{ cueAddress: 'vs.cuechat.org' }, { cueCode: 'ABCD-EFGH-JKMN' }, { cueAddress: 'http://bad', cueCode: 'invalid' }, { cueAddress: 'vs.cuechat.org', cueCode: 'ABCD-EFGH-JKMN', tunnelToken: 'secret' }, { connection: 'local' as const, publicUrl: 'https://vs.cuechat.org' }]) await assert.rejects(connectionOptions({}, { ...options, yes: true }, undefined, claim));
  assert.equal(claims, 0);
});

test('manual and local connections stay available and do not call Cue', async () => {
  const claim = async () => { throw new Error('must not call Cue'); };
  assert.deepEqual(await connectionOptions({}, { yes: true, tunnelToken: 'private', publicUrl: 'https://manual.example.org' }, undefined, claim), { yes: true, connection: 'tunnel', tunnelToken: 'private', publicUrl: 'https://manual.example.org' });
  const answers = ['2', 'private', 'https://manual.example.org'];
  const manual = await connectionOptions({}, {}, { print: () => {}, ask: async () => answers.shift()! }, claim);
  assert.equal(manual.connection, 'tunnel'); assert.equal(manual.tunnelToken, 'private');
  assert.deepEqual(await connectionOptions({}, { yes: true }, undefined, claim), { yes: true });
});
