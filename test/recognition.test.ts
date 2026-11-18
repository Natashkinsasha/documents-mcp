import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Extractor, type ExtractOptions } from '../src/extract/runner.js';
import { extractPdf } from '../src/extract/pdf.js';
import type { OcrEngine } from '../src/extract/ocr.js';
import { PathGuard } from '../src/paths.js';
import { prepareRuntime } from '../src/runtime.js';
import { Tools } from '../src/tools.js';
import { INTERRUPTED, InterruptedError, OCR_DEFERRED, type Extraction } from '../src/types.js';
import { projectRoot, resultText, scannedPdf, tempProject } from './helpers.js';

type Extract = (file: string, options?: ExtractOptions) => Promise<Extraction>;
const page = (number: number, text: string) => ({ label: `Страница ${number}`, text });
const done = (text = 'Готовый текст документа'): Extraction => ({ parts: [page(1, text)], partial: false });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function open(context: TestContext, name: string) {
  const fixture = await tempProject(name);
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  const extractor = (app.indexer as unknown as { extractor: { extract: Extract; requestYield(): void } }).extractor;
  const add = async (file: string) => { await writeFile(path.join(fixture.docs, file), '%PDF-содержимое'); return stat(path.join(fixture.docs, file)); };
  return { fixture, app, extractor, add };
}

test('a read that runs out of time gets the text so far and the pages still waiting', async (context) => {
  const { app, extractor, add } = await open(context, 'read-partial');
  const info = await add('смета.pdf');
  app.store.put('смета.pdf', info.size, info.mtimeMs, 'partial', OCR_DEFERRED, [{ seq: 0, label: 'Страница 1', text: 'Текстовый слой' }, { seq: 1, label: 'Страница 3', text: 'шум' }], undefined, [2, 3, 4]);
  app.store.saveRecognizedPage('смета.pdf', info.size, info.mtimeMs, 3, 'Распознанная страница');
  let finish!: (value: Extraction) => void;
  extractor.extract = () => new Promise((resolve) => { finish = resolve; });
  const result = await new Tools(app.indexer, 5).call('read_document', { path: 'смета.pdf' });
  const text = resultText(result);
  assert.equal(result.isError, undefined);
  assert.ok(text.indexOf('Текстовый слой') < text.indexOf('Распознанная страница'));
  assert.doesNotMatch(text, /шум/u);
  assert.match(text, /Распознано страниц: 1 из 3/u); assert.match(text, /не распознаны страницы: 2, 4/u);
  while (!finish) await tick();
  finish(done());
});

test('a read with no text yet gets the state of the work instead of an error', async (context) => {
  const { app, extractor, add } = await open(context, 'read-state');
  await add('скан.pdf');
  let finish!: (value: Extraction) => void;
  extractor.extract = () => new Promise((resolve) => { finish = resolve; });
  const result = await new Tools(app.indexer, 5).call('read_document', { path: 'скан.pdf' });
  assert.equal(result.isError, undefined);
  assert.match(resultText(result), /Состояние: обрабатывается/u); assert.match(resultText(result), /Текст пока не готов/u);
  while (!finish) await tick();
  finish({ parts: [], partial: false });
});

test('a requested file overtakes background recognition, which then resumes', async (context) => {
  const { app, extractor, add } = await open(context, 'priority');
  for (const file of ['фон.pdf', 'ещё.pdf', 'нужный.pdf']) {
    const info = await add(file);
    app.store.put(file, info.size, info.mtimeMs, 'partial', OCR_DEFERRED, [], undefined, [1, 2]);
  }
  const calls: string[] = [];
  let started = false;
  extractor.extract = async (file, options) => {
    calls.push(file);
    if (file === 'фон.pdf' && !started) {
      started = true;
      options?.onPage?.(1, 'Первая страница');
      while (!options?.yielding?.()) await tick();
      return { parts: [], partial: true, ocrDeferred: true, reason: OCR_DEFERRED, yielded: true };
    }
    if (file === 'фон.pdf') assert.deepEqual([...(options?.known ?? [])], [[1, 'Первая страница']]);
    return done();
  };
  const background = app.indexer.ensure('фон.pdf');
  const queued = app.indexer.ensure('ещё.pdf');
  while (!started) await tick();
  await app.indexer.ensure('нужный.pdf', { urgent: true });
  await Promise.all([background, queued]);
  assert.deepEqual(calls, ['фон.pdf', 'нужный.pdf', 'фон.pdf', 'ещё.pdf']);
  assert.equal(app.store.get('фон.pdf')?.status, 'ok');
  assert.deepEqual(app.store.recognitionPages('фон.pdf', app.store.get('фон.pdf')!.size, app.store.get('фон.pdf')!.mtime_ms), []);
});

test('recognized pages reach the next run of the same file version only', async (context) => {
  const { app, extractor, add } = await open(context, 'resume');
  const info = await add('скан.pdf');
  app.store.put('скан.pdf', info.size, info.mtimeMs, 'partial', OCR_DEFERRED, [], undefined, [1, 2]);
  app.store.saveRecognizedPage('скан.pdf', info.size, info.mtimeMs, 1, 'Первая');
  app.store.put('скан.pdf', info.size, info.mtimeMs, 'partial', OCR_DEFERRED, [], undefined, [1, 2]);
  const seen: [number, string][][] = [];
  extractor.extract = async (_file, options) => { seen.push([...(options?.known ?? [])]); return done(); };
  await app.indexer.ensure('скан.pdf');
  assert.deepEqual(seen, [[[1, 'Первая']]]);
  app.store.saveRecognizedPage('скан.pdf', info.size + 1, info.mtimeMs, 1, 'Другая версия');
  assert.deepEqual(app.store.recognitionPages('скан.pdf', info.size, info.mtimeMs), []);
});

test('interrupted processing is repeated, then reported, and an old interruption is picked up again', async (context) => {
  const { app, extractor, add } = await open(context, 'retry');
  await add('а.txt');
  let calls = 0;
  extractor.extract = async () => { calls++; if (calls < 3) throw new InterruptedError(INTERRUPTED); return done(); };
  await app.indexer.ensure('а.txt');
  assert.equal(calls, 3); assert.equal(app.store.get('а.txt')?.status, 'ok');
  const info = await add('б.txt');
  app.store.put('б.txt', info.size, info.mtimeMs, 'error', INTERRUPTED, []);
  calls = 0;
  extractor.extract = async () => { calls++; throw new InterruptedError(INTERRUPTED); };
  await app.indexer.ensure('б.txt');
  assert.equal(calls, 3); assert.equal(app.store.get('б.txt')?.error, INTERRUPTED);
  await app.indexer.ensure('б.txt');
  assert.equal(calls, 3);
});

test('a scanned PDF skips recognized pages, reports new ones and stops between pages', async (context) => {
  const fixture = await tempProject('pdf-resume'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const runtime = await prepareRuntime(fixture.config.indexDir);
  const file = path.join(fixture.docs, 'скан.pdf'); await scannedPdf(file, path.join(projectRoot, 'test/fixtures/russian.png'), 3);
  let recognized = 0;
  const ocr = { recognize: async () => `Страница номер ${++recognized}` } as unknown as OcrEngine;
  const reported: [number, string | undefined][] = [];
  const stopped = await extractPdf(file, runtime, ocr, 10, true, { known: new Map([[1, 'Известная']]), shouldYield: () => recognized === 1, onPage: (number, text) => reported.push([number, text]) });
  assert.equal(stopped.yielded, true); assert.equal(recognized, 1);
  assert.deepEqual(reported, [[1, undefined], [2, 'Страница номер 1']]);
  assert.deepEqual(stopped.scanPages, [1, 2, 3]);
  assert.deepEqual((await extractPdf(file, runtime, ocr, 10, false)).scanPages, [1, 2, 3]);
});

test('the watchdog counts time without progress, not the length of the job', async (context) => {
  const fixture = await tempProject('watchdog');
  const runtime = path.join(fixture.directory, 'runtime'); await mkdir(runtime);
  await writeFile(path.join(runtime, 'extract-worker.cjs'), `const {parentPort}=require('node:worker_threads');const fs=require('node:fs');
parentPort.on('message',m=>{if(m.stop){parentPort.close();return;}if(m.yieldOnly)return;const hang=fs.readFileSync(m.file,'utf8')==='hang';let n=0;
const t=setInterval(()=>{n++;parentPort.postMessage({id:m.id,page:n});if(n===8){clearInterval(t);if(!hang)parentPort.postMessage({id:m.id,result:{parts:[],partial:false}});}},40);});`);
  await writeFile(path.join(fixture.docs, 'good.txt'), 'good'); await writeFile(path.join(fixture.docs, 'hang.txt'), 'hang');
  const extractor = new Extractor(new PathGuard(fixture.docs, []), runtime, ['rus'], 1000, 1, 150);
  context.after(async () => { await extractor.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  assert.equal((await extractor.extract('good.txt')).partial, false);
  await assert.rejects(extractor.extract('hang.txt'), InterruptedError);
});

test('with the real worker a scan gives way to a request and survives losing the worker', async (context) => {
  const { fixture, app, extractor } = await open(context, 'real-resume');
  await scannedPdf(path.join(fixture.docs, 'скан.pdf'), path.join(projectRoot, 'test/fixtures/russian.png'), 3);
  await writeFile(path.join(fixture.docs, 'договор.txt'), 'Договор поставки');
  await app.indexer.ensure('скан.pdf', { recognize: false });
  const info = await stat(path.join(fixture.docs, 'скан.pdf'));
  const recognized = () => app.store.recognitionPages('скан.pdf', info.size, info.mtimeMs).filter((row) => row.text !== null).length;
  const known: number[] = [];
  const original = extractor.extract.bind(extractor);
  extractor.extract = (file, options) => { if (file === 'скан.pdf') known.push(options?.known?.size ?? 0); return original(file, options); };
  const scan = app.indexer.ensure('скан.pdf');
  while (!recognized()) await tick();
  await app.indexer.ensure('договор.txt', { urgent: true });
  assert.equal(app.store.get('договор.txt')?.status, 'ok');
  assert.equal(app.store.get('скан.pdf')?.error, OCR_DEFERRED);
  const before = known.length;
  while (known.length === before) await tick();
  await (extractor as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
  await scan;
  assert.equal(app.store.get('скан.pdf')?.status, 'ok', app.store.get('скан.pdf')?.error ?? '');
  assert.equal(known[0], 0); assert.ok(known.slice(1).every((size) => size >= 1), known.join());
  assert.ok(known.length >= 3, known.join());
});
