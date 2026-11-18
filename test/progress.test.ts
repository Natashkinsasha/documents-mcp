import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm, stat, writeFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { OCR_DEFERRED } from '../src/types.js';
import { resultText, tempProject } from './helpers.js';

async function indexedApp(context: TestContext, prefix: string) {
  const fixture = await tempProject(prefix);
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  for (let index = 0; index < 8; index++) await writeFile(path.join(fixture.docs, `файл-${index}.txt`), index === 0 ? 'Морской причал' : `Договор ${index}`);
  await app.indexer.rescan();
  return { app, fixture };
}

test('a search checks only the files it returns, even while indexing goes on', async (context) => {
  const { app, fixture } = await indexedApp(context, 'search-progress');
  await writeFile(path.join(fixture.docs, 'скан.pdf'), 'scan');
  const scan = await stat(path.join(fixture.docs, 'скан.pdf'));
  app.store.put('скан.pdf', scan.size, scan.mtimeMs, 'partial', OCR_DEFERRED, []);
  app.indexer.discovered.add('скан.pdf');
  app.indexer.discovered.add('ещё-не-прочитан.txt');
  app.indexer.scanning = true;
  const resolve = context.mock.method(app.indexer.guard, 'resolve');
  const answer = resultText(await app.tools.call('search_documents', { query: 'Морской причал' }));
  app.indexer.scanning = false;
  assert.match(answer, /файл-0\.txt/u);
  assert.match(answer, /Индексация ещё идёт: обработано 8 из 10 файлов/u);
  // The search folder and the one hit.
  assert.equal(resolve.mock.callCount(), 2);
});

test('progress checks each file once, a few at a time, and concurrent readers share the pass', async (context) => {
  const { app } = await indexedApp(context, 'progress-pass');
  const guard = app.indexer.guard;
  const original = guard.resolve.bind(guard);
  let active = 0;
  let peak = 0;
  const resolve = context.mock.method(guard, 'resolve', async (...args: Parameters<typeof original>) => {
    peak = Math.max(peak, ++active);
    await nextTurn();
    try { return await original(...args); } finally { active--; }
  });
  const [first, second] = await Promise.all([app.indexer.progress(), app.indexer.progress()]);
  assert.equal(first.ready, 8);
  assert.deepEqual(second, first);
  assert.equal(resolve.mock.callCount(), 8);
  assert.equal(peak, 3);
  await app.indexer.progress();
  assert.equal(resolve.mock.callCount(), 16);
});
