import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { Control } from '../src/control.js';
import { OCR_DEFERRED } from '../src/types.js';
import { VERSION } from '../src/version.js';
import { projectRoot, resultText, scannedPdf, tempProject } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof tempProject>>;
async function open(context: TestContext, name: string, logs: Record<string, unknown>[] = []) {
  const fixture = await tempProject(name);
  fixture.config.port = 0;
  const app = await createApp(fixture.config, { logger: (entry) => { logs.push(entry); } });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  return { fixture, app, control: new Control(app.indexer) };
}
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) { if (await check()) return; await delay(10); }
  assert.fail('condition was not reached');
}
const write = (fixture: Fixture, name: string, text = 'Договор поставки') => writeFile(path.join(fixture.docs, name), text);

test('control endpoints are authenticated, refuse browsers and validate requests', async (context) => {
  const { fixture, app } = await open(context, 'control-http');
  await app.start();
  const address = app.http.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${fixture.config.token}` };
  const post = (route: string, body: string) => fetch(`${base}${route}`, { method: 'POST', headers, body });
  for (const route of ['/control/status', '/control/indexing', '/control/recognition', '/control/rescan']) {
    const response = await fetch(`${base}${route}`, { method: route === '/control/status' ? 'GET' : 'POST' });
    assert.equal(response.status, 401); assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await fetch(`${base}${route}`, { method: route === '/control/status' ? 'GET' : 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403);
    const wrong = await fetch(`${base}${route}`, { method: 'DELETE', headers });
    assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('allow'), route === '/control/status' ? 'GET' : 'POST');
  }
  for (const body of ['', 'nope', '{}', '{"paused":"yes"}', '{"paused":true,"extra":1}']) assert.equal((await post('/control/indexing', body)).status, 400, body);
  assert.equal((await post('/control/recognition', JSON.stringify({ paused: true, padding: 'x'.repeat(5000) }))).status, 413);
  const paused = await post('/control/indexing', '{"paused":true}');
  assert.equal(paused.status, 200); assert.equal(paused.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await paused.json().then((value) => { const { paused, version } = value as { paused: boolean; version: string }; return { paused, version }; }), { paused: true, version: VERSION });
  assert.equal((await post('/control/indexing', '{"paused":true}')).status, 200);
  const rescan = await post('/control/rescan', '');
  assert.equal(rescan.status, 202);
  assert.deepEqual(await rescan.json(), { accepted: true });
});

test('a paused index only discovers files, yet a requested document is read and resuming continues', async (context) => {
  const { fixture, app, control } = await open(context, 'control-pause');
  await write(fixture, 'первый.txt');
  await control.setIndexingPaused(true);
  await app.indexer.rescan();
  let status = await control.status();
  assert.deepEqual([status.paused, status.scanning, status.counts.total, status.counts.pending, status.counts.ready, status.lastScanAt], [true, false, 1, 1, 0, null]);
  assert.equal(app.store.get('первый.txt'), undefined);
  assert.match(resultText(await app.tools.call('read_document', { path: 'первый.txt' })), /Договор поставки/u);
  assert.equal((await control.status()).counts.ready, 1);
  await write(fixture, 'второй.txt');
  control.rescan();
  await until(async () => (await control.status()).counts.total === 2);
  assert.equal(app.store.get('второй.txt'), undefined);
  status = await control.setIndexingPaused(false);
  assert.equal(status.paused, false);
  await until(async () => (await control.status()).counts.ready === 2);
});

test('deferred recognition leaves scans waiting, yet a requested scan is recognized at once', async (context) => {
  const { fixture, app, control } = await open(context, 'control-recognition');
  await scannedPdf(path.join(fixture.docs, 'скан.pdf'), path.join(projectRoot, 'test/fixtures/russian.png'));
  await write(fixture, 'текст.txt');
  await control.setRecognitionPaused(true);
  const extractor = (app.indexer as unknown as { extractor: { extract(file: string, options?: { recognize?: boolean }): Promise<unknown> } }).extractor;
  const original = extractor.extract.bind(extractor);
  const calls: string[] = [];
  extractor.extract = (file, options) => { calls.push(`${file}:${options?.recognize === false ? 'text' : 'full'}`); return original(file, options); };
  await app.indexer.rescan();
  assert.ok(!calls.some((call) => call.endsWith(':full')), calls.join());
  const status = await control.status();
  assert.deepEqual([status.recognitionPaused, status.counts.ready, status.counts.recognition, status.scanning], [true, 1, 1, false]);
  assert.ok(status.lastScanAt);
  await app.indexer.ensure('скан.pdf');
  assert.notEqual(app.store.get('скан.pdf')?.error, OCR_DEFERRED);
  assert.ok(calls.includes('скан.pdf:full'));
});

test('switches survive a restart and a damaged file falls back to defaults', async (context) => {
  const logs: Record<string, unknown>[] = [];
  const { fixture, app, control } = await open(context, 'control-saved', logs);
  await control.setIndexingPaused(true); await control.setRecognitionPaused(true);
  const file = path.join(fixture.config.indexDir, 'indexing-controls.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { paused: true, recognitionPaused: true });
  await app.close();
  const again = await createApp(fixture.config, { logger: () => {} });
  assert.deepEqual([again.indexer.paused, again.indexer.recognitionPaused], [true, true]);
  await again.close();
  await writeFile(file, '{broken');
  const damaged = await createApp(fixture.config, { logger: (entry) => { logs.push(entry); } });
  assert.deepEqual([damaged.indexer.paused, damaged.indexer.recognitionPaused], [false, false]);
  assert.ok(logs.some((entry) => entry.level === 'warn' && !JSON.stringify(entry).includes(fixture.directory)));
  await damaged.close();
});

test('rescan requests during a pass collapse into one following pass', async (context) => {
  const { app, control } = await open(context, 'control-rescan');
  const indexer = app.indexer as unknown as { scan(): Promise<void> };
  const original = indexer.scan.bind(indexer);
  let passes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  indexer.scan = async () => { passes++; if (passes === 1) await gate; return original(); };
  control.rescan(); await until(() => passes === 1);
  control.rescan(); control.rescan();
  release();
  await until(() => passes === 2 && !app.indexer.scanning);
  await delay(30);
  assert.equal(passes, 2);
});

test('failures are limited to relative paths and MCP status keeps its text', async (context) => {
  const { fixture, app, control } = await open(context, 'control-failures');
  fixture.config.maxFileBytes = 4;
  for (let index = 0; index < 21; index++) await write(fixture, `большой-${String(index).padStart(2, '0')}.txt`);
  await app.indexer.rescan();
  const status = await control.status();
  assert.deepEqual([status.counts.failed, status.failures.length, status.failuresTruncated], [21, 20, true]);
  assert.deepEqual(status.failures[0], { path: 'большой-00.txt', error: 'Файл слишком большой.' });
  assert.ok(!JSON.stringify(status).includes(fixture.directory));
  const text = resultText(await app.tools.call('documents_status', {})).split('\n');
  assert.deepEqual(text.slice(0, 3), ['Всего файлов: 21', 'Готово: 0', 'Ожидают: 0']);
  assert.equal(text[3], 'Ждут распознавания (сканы и изображения, после остальных): 0');
  assert.equal(text[7], 'Индексация идёт: нет');
  assert.match(text[8]!, /^Последний завершённый обход: \d{4}-/u);
  assert.equal(text[9], 'Файлы с ошибками:');
});
