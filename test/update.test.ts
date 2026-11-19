import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RemoteUpdate, type UpdateDependencies } from '../src/update.js';
import { UPDATE_ASSET, UPDATE_ORIGIN, UPDATE_PUBLIC_KEY, newer, signedManifest, UpdateError, verifyUpdateFile } from '../src/update-manifest.js';
import { allowedUpdateUrl, downloadUpdate, fetchManifest, type DownloadDependencies } from '../src/update-download.js';
import { idleUpdate, readJson, saveUpdate, updateLock, updatePaths, type UpdateRecord } from '../src/update-storage.js';
import { applyUpdate, versionHealth } from '../src/update-apply.js';
import { defaultPaths, readConfigFile, serializeConfig } from '../src/config.js';
import { upgradeSettings } from '../src/install.js';
import { windowsTask } from '../src/service.js';
import { createApp } from '../src/app.js';
import { Control } from '../src/control.js';
import { VERSION } from '../src/version.js';
import { tempProject } from './helpers.js';

const [major, minor] = VERSION.split('.').map(Number);
// Update targets stay newer than the current release, so bumping VERSION does not break these tests.
const TARGET = `${major}.${minor + 1}.0`;
const LATER = `${major}.${minor + 2}.0`;

const keys = generateKeyPairSync('ed25519');
const payload = Buffer.from('test executable, never executed');
function release(version = TARGET, content = payload, extra: Record<string, unknown> = {}) {
  const manifest = { schema: 1, version, assets: { 'win-x64': { name: UPDATE_ASSET, size: content.length, sha256: createHash('sha256').update(content).digest('hex') } }, ...extra };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { bytes, signature: sign(null, bytes, keys.privateKey).toString('base64'), manifest, content };
}
type Release = ReturnType<typeof release>;
function source(current: Release, binary: (init?: RequestInit) => Response = () => new Response(current.content)): typeof fetch {
  return (async (input, init) => {
    const url = String(input); assert.ok(url.startsWith(UPDATE_ORIGIN));
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    if (url.endsWith('update-manifest.json.sig')) return new Response(current.signature);
    if (url.endsWith('update-manifest.json')) return new Response(current.bytes);
    assert.ok(url.endsWith(UPDATE_ASSET)); return binary(init);
  }) as typeof fetch;
}
async function fixture(context: TestContext) {
  await mkdir('.cache', { recursive: true });
  const directory = await mkdtemp(path.resolve('.cache/update-test-'));
  const paths = { binary: path.join(directory, 'program', 'documents-mcp.exe'), config: path.join(directory, 'data', 'config.env'), data: path.join(directory, 'data'), service: path.join(directory, 'data', 'task.xml') };
  await mkdir(path.dirname(paths.binary)); await mkdir(paths.data);
  await writeFile(paths.binary, 'old executable');
  const settings = { MCP_TOKEN: 'a'.repeat(64), PORT: '3000', INSTALLED_VERSION: VERSION, REMOTE_UPDATE: '1', READ_ONLY: '1', DOCS_ROOT: path.join(directory, 'docs') };
  await writeFile(paths.config, serializeConfig(settings));
  const dependencies: UpdateDependencies = { platform: 'win32', arch: 'x64', paths, current: VERSION, key: keys.publicKey, fetch: source(release()), now: () => 4_000_000, sleep: async () => {}, freeSpace: async () => 10 ** 12, protect: async () => {}, schedule: async () => {}, taskExists: async () => false, removeTask: async () => {} };
  const controllers: RemoteUpdate[] = [];
  context.after(async () => { for (const controller of controllers) await controller.close(); await rm(directory, { recursive: true, force: true }); });
  async function controller(allowed = true, overrides: Partial<UpdateDependencies> = {}) {
    const update = new RemoteUpdate(allowed, { ...dependencies, ...overrides }); controllers.push(update); await update.initialize(); return update;
  }
  return { directory, paths, settings, dependencies, controller, files: updatePaths(paths) };
}
const errorCode = (code: string) => (error: unknown) => error instanceof UpdateError && error.code === code;
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await delay(5); }
  assert.fail('condition not reached');
}

test('signature is verified before parsing, and signed schema/versions are strict', () => {
  const official = release(); assert.equal(signedManifest(official.bytes, official.signature, keys.publicKey).version, TARGET);
  const badJson = Buffer.from('not json');
  assert.throws(() => signedManifest(badJson, official.signature, keys.publicKey), errorCode('signature'));
  assert.throws(() => signedManifest(Buffer.from(official.bytes.toString().replace(TARGET, '9.0.0')), official.signature, keys.publicKey), errorCode('signature'));
  const other = generateKeyPairSync('ed25519');
  assert.throws(() => signedManifest(official.bytes, sign(null, official.bytes, other.privateKey).toString('base64'), keys.publicKey), errorCode('signature'));
  for (const invalid of [release(`0${TARGET}`), release(`${TARGET}-beta`), release(`${TARGET}+build`), release(TARGET, payload, { url: 'https://evil.invalid' }), release(TARGET, payload, { schema: 2 })]) assert.throws(() => signedManifest(invalid.bytes, invalid.signature, keys.publicKey), errorCode('signature'));
  for (const asset of [{ name: '../evil.exe' }, { size: 0 }, { size: 1024 ** 3 + 1 }, { sha256: 'bad' }, { command: 'evil' }]) {
    const invalid = release(TARGET, payload, { assets: { 'win-x64': { ...official.manifest.assets['win-x64'], ...asset } } });
    assert.throws(() => signedManifest(invalid.bytes, invalid.signature, keys.publicKey), errorCode('signature'));
  }
  assert.equal(newer('1.10.0', '1.9.0'), true); assert.equal(newer('1.5.0', VERSION), false);
  assert.equal(UPDATE_PUBLIC_KEY, 'MCowBQYDK2VwAyEAlAcW0zwDfxC7SF1l3ddPxPZytpFelBpq/JmsmzKcb2E=');
});

for (const version of ['1.4.0', VERSION]) test(`rejects ${version} without downloading or scheduling`, async (context) => {
  const state = await fixture(context); let binary = 0;
  const update = await state.controller(true, { fetch: source(release(version), () => { binary++; return new Response(payload); }), schedule: async () => assert.fail('no scheduling') });
  await update.start(); await update.settled();
  assert.equal((await update.status(false)).error, 'not_newer'); assert.equal(binary, 0);
});

test('disabled and unsupported never start, independent of read-only mode', async (context) => {
  const state = await fixture(context);
  const disabled = await state.controller(false);
  await assert.rejects(disabled.start(), errorCode('disabled'));
  assert.equal((await disabled.status(false)).allowed, false);
  for (const platform of ['linux', 'darwin'] as const) {
    const unsupported = await state.controller(true, { platform, fetch: (async () => assert.fail('no network')) as typeof fetch });
    assert.equal((await unsupported.status()).supported, false);
    await assert.rejects(unsupported.start(), errorCode('unsupported'));
  }
  const supported = await state.controller(); await supported.start(); await supported.settled();
  assert.equal((await supported.status(false)).state, 'installing');
});

test('download verifies file before any execution and rejects shortage', async (context) => {
  const state = await fixture(context); let scheduled = 0;
  const tampered = await state.controller(true, { fetch: source(release(), () => new Response(Buffer.alloc(payload.length))), schedule: async () => { scheduled++; } });
  await tampered.start(); await tampered.settled(); assert.equal((await tampered.status(false)).error, 'integrity'); assert.equal(scheduled, 0);
  await assert.rejects(stat(state.files.partial));
  const full = await state.controller(true, { freeSpace: async () => 0 });
  await full.start(); await full.settled(); assert.equal((await full.status(false)).error, 'disk');
});

test('redirect allowlist refuses HTTP, lookalikes, credentials, ports and other hosts', async (context) => {
  const state = await fixture(context);
  for (const address of ['http://github.com/a', 'https://github.com.evil.invalid/a', 'https://evil.invalid/a', 'https://githubusercontent.com/a', 'https://xgithubusercontent.com/a', 'https://user@github.com/a', 'https://github.com:444/a']) {
    assert.equal(allowedUpdateUrl(new URL(address)), false);
    let calls = 0;
    await assert.rejects(fetchManifest({ ...state.dependencies, signal: new AbortController().signal, fetch: (async () => { calls++; return new Response(null, { status: 302, headers: { Location: address } }); }) as typeof fetch }), errorCode('network'));
    assert.equal(calls, 1);
  }
  assert.equal(allowedUpdateUrl(new URL('https://release-assets.githubusercontent.com/asset')), true);
});

test('Range resumes interrupted stream and keeps progress across restart', async (context) => {
  const state = await fixture(context); let binaryCalls = 0;
  const current = release();
  const fetch = source(current, (init) => {
    binaryCalls++;
    if (binaryCalls === 1) {
      let sent = false;
      return new Response(new ReadableStream({ pull(output) { if (!sent) { sent = true; output.enqueue(payload.subarray(0, 7)); } else output.error(new Error('offline')); } }));
    }
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=7-');
    return new Response(payload.subarray(7), { status: 206, headers: { 'Content-Range': `bytes 7-${payload.length - 1}/${payload.length}` } });
  });
  await mkdir(state.files.directory);
  let retries = 0;
  await downloadUpdate(state.paths, { ...state.dependencies, fetch, signal: new AbortController().signal, sleep: async () => { retries++; } }, async () => {});
  assert.equal(retries, 1); assert.deepEqual(await readFile(state.files.partial), payload);
  await saveUpdate(state.paths, { ...idleUpdate(), from: VERSION, state: 'downloading', target: TARGET, received: 7 });
  await writeFile(state.files.partial, payload.subarray(0, 7));
  const restarted = await state.controller(true, { fetch });
  assert.equal((await restarted.status(false)).error, 'interrupted');
  await restarted.start(); await restarted.settled();
  assert.equal((await restarted.status(false)).state, 'installing'); assert.equal(binaryCalls, 3);
});

test('a different signed manifest discards partial and never resumes against its bytes', async (context) => {
  const state = await fixture(context); const previous = release(TARGET); const next = release(LATER, Buffer.from('different new binary'));
  await mkdir(state.files.directory); await writeFile(state.files.manifest, previous.bytes); await writeFile(state.files.partial, payload.subarray(0, 7));
  const fetch = source(next, (init) => { assert.equal(new Headers(init?.headers).has('range'), false); return new Response(next.content); });
  const update = await state.controller(true, { fetch }); await update.start(); await update.settled();
  assert.deepEqual(await readFile(state.files.candidate), next.content); assert.equal((await update.status(false)).target, LATER);
});

test('double start and cross-process lock allow only one job', async (context) => {
  const state = await fixture(context); let scheduled = 0; let finish: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const first = await state.controller(true, { schedule: async () => { scheduled++; await waiting; } });
  const second = await state.controller(true, { schedule: async () => { scheduled++; await waiting; } });
  await Promise.all([first.start(), first.start(), second.start()]);
  await until(async () => scheduled === 1);
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); try {db.exec('BEGIN IMMEDIATE'); process.exitCode=2} catch {process.exitCode=0} finally {db.close()}", state.files.lock], { stdio: 'ignore' });
  assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0);
  finish(); await first.settled(); await second.settled(); assert.equal(scheduled, 1);
});

test('GET never waits for network and background availability is throttled across controllers', async (context) => {
  const state = await fixture(context); let calls = 0; let unblock: () => void = () => {};
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => { calls++; await gate; return source(release())(input, init); }) as typeof globalThis.fetch;
  const update = await state.controller(true, { fetch });
  const initial = await update.status(); assert.equal(initial.available, null);
  await until(async () => calls === 1); unblock();
  await until(async () => (await update.status(false)).available === TARGET);
  await update.status();
  const another = await state.controller(true, { fetch }); await another.status(); await delay(30);
  assert.equal(calls, 2);
  // The cached release stops being offered once the program runs it, without waiting for the next hourly check.
  assert.equal((await (await state.controller(true, { fetch, current: TARGET })).status(false)).available, null);
});

test('update files must not be exposed through documents, custom index or symlink', async (context) => {
  const state = await fixture(context);
  const exposed = await state.controller(true, { docsRoot: state.directory }); await assert.rejects(exposed.start(), errorCode('disk'));
  const indexed = await state.controller(true, { indexDir: state.directory }); await assert.rejects(indexed.start(), errorCode('disk'));
  await mkdir(path.join(state.directory, 'elsewhere')); await symlink(path.join(state.directory, 'elsewhere'), state.files.directory);
  const linked = await state.controller(); await assert.rejects(linked.start(), errorCode('disk'));
});

test('consent is opt-in and ordinary upgrades preserve enabled/disabled values', () => {
  const paths = defaultPaths('win32');
  for (const previous of [{}, { REMOTE_UPDATE: '0' }, { REMOTE_UPDATE: '1' }]) {
    assert.equal(upgradeSettings(previous, {}, paths, 'win32').REMOTE_UPDATE, previous.REMOTE_UPDATE ?? '0');
    assert.equal(upgradeSettings(previous, { allowRemoteUpdate: true }, paths, 'win32').REMOTE_UPDATE, '1');
  }
});

for (const scenario of ['success', 'swap', 'health', 'start', 'interrupted'] as const) test(`apply-update ${scenario}, exact config rollback and restart state`, async (context) => {
  const state = await fixture(context); const current = release(); const calls: string[] = [];
  const update = await state.controller(); await update.start(); await update.settled();
  const before = await readFile(state.paths.config);
  if (scenario === 'interrupted') {
    await writeFile(state.files.previous, 'old executable'); await writeFile(state.files.configBackup, before);
    await saveUpdate(state.paths, { ...idleUpdate(), from: VERSION, target: TARGET, state: 'installing', phase: 'backed_up' });
    await rm(state.paths.binary);
  }
  let swapFailed = false; let startFailed = false; let removed = 0;
  await applyUpdate(state.paths, {
    platform: 'win32', version: TARGET, executable: state.files.candidate, key: keys.publicKey, administrator: async () => {},
    swap: async (source, destination) => { if (scenario === 'swap' && source === state.files.staged && !swapFailed) { swapFailed = true; throw new Error('locked'); } await rename(source, destination); },
    service: async (action) => { calls.push(action); if (scenario === 'start' && action === 'start' && !startFailed) { startFailed = true; throw new Error('scheduler refused'); } return ''; },
    health: async (settings, target) => { assert.equal(settings.MCP_TOKEN, state.settings.MCP_TOKEN); assert.equal(target, TARGET); return scenario !== 'health'; },
    removeTask: async () => { removed++; },
  });
  const result = await readJson<UpdateRecord>(state.files.state);
  assert.equal(removed, 1);
  if (scenario === 'success') {
    assert.deepEqual(await readFile(state.paths.binary), current.content);
    assert.equal((await readConfigFile(state.paths.config)).INSTALLED_VERSION, TARGET);
    assert.equal(result?.state, 'idle'); assert.equal(result?.error, null); assert.deepEqual(calls, ['stop', 'start']);
  } else {
    assert.equal(await readFile(state.paths.binary, 'utf8'), 'old executable');
    assert.deepEqual(await readFile(state.paths.config), before);
    assert.equal(result?.state, 'failed'); assert.equal(result?.error, scenario === 'health' ? 'health' : scenario === 'interrupted' ? 'interrupted' : 'install');
    assert.equal(calls.at(-1), 'start');
  }
  assert.equal(await readFile(state.files.previous, 'utf8'), 'old executable');
  for (const file of [state.files.candidate, state.files.manifest, state.files.configBackup]) await assert.rejects(stat(file));
  const restarted = await state.controller(true, { current: scenario === 'success' ? TARGET : VERSION });
  assert.equal((await restarted.status(false)).state, result?.state); assert.equal((await restarted.status(false)).error, result?.error);
});

test('apply-update verifies its own bytes and does not stop service on mismatch', async (context) => {
  const state = await fixture(context); const update = await state.controller(); await update.start(); await update.settled();
  await writeFile(state.files.candidate, 'tampered executable');
  await applyUpdate(state.paths, { platform: 'win32', version: TARGET, executable: state.files.candidate, key: keys.publicKey, administrator: async () => {}, service: async () => assert.fail('must not stop'), removeTask: async () => {} });
  assert.equal((await readJson<UpdateRecord>(state.files.state))?.error, 'integrity');
  assert.equal(await readFile(state.paths.binary, 'utf8'), 'old executable');
});

test('apply-update rechecks consent and executable-volume space before stopping', async (context) => {
  const state = await fixture(context);
  for (const failure of ['disabled', 'disk']) {
    const update = await state.controller(); await update.start(); await update.settled();
    await writeFile(state.paths.config, serializeConfig({ ...state.settings, REMOTE_UPDATE: failure === 'disabled' ? '0' : '1' }));
    await applyUpdate(state.paths, { platform: 'win32', version: TARGET, executable: state.files.candidate, key: keys.publicKey, administrator: async () => {}, service: async () => assert.fail('must not stop'), freeSpace: async () => failure === 'disk' ? 0 : 10 ** 12, removeTask: async () => {} });
    assert.equal((await readJson<UpdateRecord>(state.files.state))?.error, failure);
    assert.equal(await readFile(state.paths.binary, 'utf8'), 'old executable');
  }
});

test('failed rollback retains journal/backups and can recover on helper retry', async (context) => {
  const state = await fixture(context); const update = await state.controller(); await update.start(); await update.settled();
  const before = await readFile(state.paths.config);
  await assert.rejects(applyUpdate(state.paths, {
    platform: 'win32', version: TARGET, executable: state.files.candidate, key: keys.publicKey, administrator: async () => {},
    service: async (action) => { if (action === 'start') throw new Error('scheduler unavailable'); return ''; },
    health: async () => false, swap: rename, removeTask: async () => assert.fail('keep recovery task'),
  }), errorCode('install'));
  const failed = await readJson<UpdateRecord>(state.files.state);
  assert.equal(failed?.error, 'install'); assert.ok(failed?.phase); assert.equal(failed?.cleanup, false);
  assert.deepEqual(await readFile(state.files.configBackup), before); assert.ok((await stat(state.files.candidate)).isFile());
  await applyUpdate(state.paths, { platform: 'win32', version: TARGET, executable: state.files.candidate, key: keys.publicKey, administrator: async () => {}, service: async () => '', swap: rename, removeTask: async () => {} });
  assert.deepEqual(await readFile(state.paths.config), before); assert.equal(await readFile(state.paths.binary, 'utf8'), 'old executable');
  assert.equal((await readJson<UpdateRecord>(state.files.state))?.error, 'interrupted');
});

test('health requires matching authenticated version and private live startup receipt', async (context) => {
  const state = await fixture(context); await mkdir(state.files.directory);
  let currentTime = 0; let version = TARGET;
  const dependencies = {
    now: () => currentTime, timeoutMs: 1, sleep: async () => { currentTime++; }, alive: (pid: number) => { assert.equal(pid, process.pid); },
    fetch: (async (input, init) => {
      assert.equal(init?.redirect, 'error');
      if (String(input).endsWith('/healthz')) return new Response('ok');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${state.settings.MCP_TOKEN}`);
      return Response.json({ version, failures: [{ path: 'long'.repeat(5000) }] });
    }) as typeof fetch,
  };
  assert.equal(await versionHealth(state.settings, TARGET, state.paths, dependencies), false);
  await writeFile(state.files.running, JSON.stringify({ version: TARGET, pid: process.pid }));
  currentTime = 0; assert.equal(await versionHealth(state.settings, TARGET, state.paths, dependencies), true);
  version = VERSION; currentTime = 0; assert.equal(await versionHealth(state.settings, TARGET, state.paths, dependencies), false);
});

test('short bodies resume, ignored Range restarts, and invalid Content-Range fails closed', async (context) => {
  const state = await fixture(context); await mkdir(state.files.directory); const current = release();
  let binary = 0;
  const fetch = source(current, (init) => {
    binary++;
    if (binary === 1) return new Response(payload.subarray(0, 3));
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=3-'); return new Response(payload);
  });
  await downloadUpdate(state.paths, { ...state.dependencies, fetch, signal: new AbortController().signal }, async () => {});
  assert.deepEqual(await readFile(state.files.partial), payload); assert.equal(binary, 2);
  await writeFile(state.files.partial, payload.subarray(0, 3));
  await assert.rejects(downloadUpdate(state.paths, { ...state.dependencies, fetch: source(current, () => new Response(payload.subarray(3), { status: 206, headers: { 'Content-Range': `bytes 0-${payload.length - 1}/${payload.length}` } })), signal: new AbortController().signal }, async () => {}), errorCode('integrity'));
});

test('signed manifest changes between retry attempts discard the old partial', async (context) => {
  const state = await fixture(context); let current = release(); const next = release(LATER, Buffer.from('replacement release'));
  let binary = 0;
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => source(current, (options) => {
    binary++;
    if (binary === 1) { current = next; return new Response(payload.subarray(0, 4)); }
    assert.equal(new Headers(options?.headers).has('Range'), false); return new Response(next.content);
  })(input, init)) as typeof globalThis.fetch;
  const update = await state.controller(true, { fetch }); await update.start(); await update.settled();
  assert.equal((await update.status(false)).target, LATER); assert.deepEqual(await readFile(state.files.candidate), next.content);
});

test('job lock is automatically released when a process crashes', async (context) => {
  const state = await fixture(context); await mkdir(state.files.directory);
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setInterval(()=>{},1000)", state.files.lock], { stdio: ['ignore', 'pipe', 'ignore'] });
  context.after(() => { child.kill('SIGKILL'); });
  await new Promise((resolve) => child.stdout!.once('data', resolve));
  assert.equal(await updateLock(state.files.lock), undefined);
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve));
  const unlock = await updateLock(state.files.lock); assert.ok(unlock); unlock();
});

test('a crash before task registration reports interrupted and allows another POST', async (context) => {
  const state = await fixture(context); const first = await state.controller(); await first.start(); await first.settled(); await first.close();
  assert.equal((await readJson<UpdateRecord>(state.files.state))?.phase, 'prepared');
  const next = await state.controller(); assert.equal((await next.status(false)).error, 'interrupted');
  await next.start(); await next.settled(); assert.equal((await next.status(false)).state, 'installing');
});

test('restart with a queued helper reports interruption but preserves its safe handoff', async (context) => {
  const state = await fixture(context); const first = await state.controller(); await first.start(); await first.settled(); await first.close();
  const next = await state.controller(true, { taskExists: async () => true });
  assert.equal((await next.status(false)).error, 'interrupted');
  assert.equal((await readJson<UpdateRecord>(state.files.state))?.phase, 'prepared');
  await applyUpdate(state.paths, { platform: 'win32', version: TARGET, executable: state.files.candidate, key: keys.publicKey, administrator: async () => {}, service: async () => '', swap: rename, health: async () => true, removeTask: async () => {} });
  assert.equal((await readJson<UpdateRecord>(state.files.state))?.state, 'idle');
});

test('one-shot task has fixed command, SYSTEM principal, IgnoreNew and no secrets', () => {
  const paths = defaultPaths('win32');
  const xml = windowsTask({ ...paths, binary: 'C:\\ProgramData\\documents-mcp\\update\\candidate.exe' }, { arguments: 'apply-update', update: true });
  assert.match(xml, /<Arguments>apply-update<\/Arguments>/u); assert.match(xml, /S-1-5-18/u); assert.match(xml, /IgnoreNew/u); assert.match(xml, /<Count>3<\/Count>/u);
  assert.doesNotMatch(xml, /MCP_TOKEN|powershell|cmd\.exe/u);
});

test('HTTP update authentication, Origin, no parameters, responses and unchanged status/MCP tools', async (context) => {
  const state = await fixture(context); const update = await state.controller();
  const fixtureApp = await tempProject('update-http'); fixtureApp.config.port = 0;
  const app = await createApp(fixtureApp.config, { updater: update, logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixtureApp.directory, { recursive: true, force: true }); });
  await app.start();
  const address = app.http.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`; const headers = { Authorization: `Bearer ${fixtureApp.config.token}` };
  for (const method of ['GET', 'POST']) {
    assert.equal((await fetch(`${base}/control/update`, { method })).status, 401);
    assert.equal((await fetch(`${base}/control/update`, { method, headers: { ...headers, Origin: '' } })).status, 403);
  }
  const wrong = await fetch(`${base}/control/update`, { method: 'DELETE', headers }); assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('allow'), 'GET, POST');
  for (const body of ['{}', '{"url":"https://evil.invalid"}', 'x']) assert.equal((await fetch(`${base}/control/update`, { method: 'POST', headers, body })).status, 400);
  assert.equal((await fetch(`${base}/control/update?version=9.0.0`, { method: 'POST', headers })).status, 400);
  const responses = await Promise.all([fetch(`${base}/control/update`, { method: 'POST', headers }), fetch(`${base}/control/update`, { method: 'POST', headers })]);
  assert.deepEqual(responses.map((response) => response.status), [202, 202]);
  const response = await fetch(`${base}/control/update`, { headers }); const status = await response.json();
  assert.deepEqual(Object.keys(status).sort(), ['supported', 'allowed', 'current', 'available', 'state', 'target', 'received', 'size', 'error'].sort());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const unchanged = await (await fetch(`${base}/control/status`, { headers })).json();
  assert.deepEqual(Object.keys(unchanged).sort(), ['version', 'paused', 'recognitionPaused', 'scanning', 'lastScanAt', 'scanFailed', 'counts', 'failures', 'failuresTruncated'].sort());
  assert.deepEqual(Object.keys(unchanged).sort(), Object.keys(await new Control(app.indexer).status()).sort());
  const tools = app.tools.names(); assert.equal(tools.length, 11); assert.ok(tools.every((tool) => !tool.includes('update')));
});

test('HTTP update reports disabled/unsupported with control error shape', async (context) => {
  const state = await fixture(context);
  for (const scenario of ['disabled', 'unsupported'] as const) {
    const fixtureApp = await tempProject('update-refused'); fixtureApp.config.port = 0;
    const update = await state.controller(scenario !== 'disabled', { platform: scenario === 'unsupported' ? 'linux' : 'win32' });
    const app = await createApp(fixtureApp.config, { updater: update, logger: () => {} });
    try {
      await app.start(); const address = app.http.address(); assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/control/update`, { method: 'POST', headers: { Authorization: `Bearer ${fixtureApp.config.token}` } });
      assert.equal(response.status, scenario === 'disabled' ? 403 : 409);
      const body = await response.json(); assert.deepEqual(Object.keys(body).sort(), ['code', 'error']); assert.equal(body.code, scenario);
    } finally { await app.close(); await rm(fixtureApp.directory, { recursive: true, force: true }); }
  }
});

test('update shares the 64-request limit with other control routes', async (context) => {
  const state = await fixture(context); const update = await state.controller();
  let entered = 0; let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const originalStatus = update.status.bind(update);
  update.status = async () => { entered++; await gate; return originalStatus(false); };
  const fixtureApp = await tempProject('update-limit'); fixtureApp.config.port = 0;
  const app = await createApp(fixtureApp.config, { updater: update, logger: () => {} });
  try {
    await app.start(); const address = app.http.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`; const headers = { Authorization: `Bearer ${fixtureApp.config.token}` };
    const pending = Array.from({ length: 64 }, () => fetch(`${base}/control/update`, { headers }));
    await until(async () => entered === 64);
    const limited = await fetch(`${base}/control/status`, { headers }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    release(); assert.ok((await Promise.all(pending)).every((response) => response.status === 200));
  } finally { release(); await app.close(); await rm(fixtureApp.directory, { recursive: true, force: true }); }
});

test('release signer uses generated keys and rejects wrong pinned key before writes', async (context) => {
  const state = await fixture(context); await writeFile(path.join(state.directory, UPDATE_ASSET), payload);
  const { signRelease } = await import('../scripts/sign-release.mjs');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await assert.rejects(signRelease({ directory: state.directory, version: TARGET, privateKey }));
  await assert.rejects(stat(path.join(state.directory, 'update-manifest.json')));
  await signRelease({ directory: state.directory, version: TARGET, privateKey, publicKey: keys.publicKey });
  const bytes = await readFile(path.join(state.directory, 'update-manifest.json')); const signature = await readFile(path.join(state.directory, 'update-manifest.json.sig'), 'utf8');
  const manifest = signedManifest(bytes, signature, keys.publicKey);
  await verifyUpdateFile(path.join(state.directory, UPDATE_ASSET), manifest);
});
