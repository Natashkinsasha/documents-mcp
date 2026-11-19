import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { renderChunks } from '../src/index/text.js';
import { OCR_DEFERRED, type Chunk } from '../src/types.js';
import { resultText, tempProject } from './helpers.js';

async function searchApp(context: TestContext, prefix: string) {
  const fixture = await tempProject(prefix);
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  const search = async (query: string) => resultText(await app.tools.call('search_documents', { query }));
  return { app, fixture, search };
}

const offsetIn = (answer: string): number => Number(/\[offset (\d+)\]/u.exec(answer)?.[1] ?? Number.NaN);

test('a search result gives the offset where read_document finds that fragment', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-offset');
  const body = `${'Вводная строка без нужного слова.\n'.repeat(300)}Гарантия на насос составляет два года.\n${'Заключительная строка.\n'.repeat(300)}`;
  await writeFile(path.join(fixture.docs, 'длинный.txt'), body);
  await app.indexer.rescan();
  const offset = offsetIn(await search('гарантия'));
  assert.ok(offset > 0);
  const read = resultText(await app.tools.call('read_document', { path: 'длинный.txt', offset, limit: 2000 }));
  assert.match(read, /Гарантия на насос/u);
});

test('offsets count part labels, separators and UTF-16 units of the rendered text', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-offset-labels');
  const file = path.join(fixture.docs, 'книга.xlsx');
  await writeFile(file, 'stored directly');
  const info = await stat(file);
  const chunks: Chunk[] = [
    { seq: 0, label: 'Лист «Первый»', text: 'Эмодзи 😀 перед искомым.' },
    { seq: 1, label: 'Лист «Первый»', text: 'Ещё строка.' },
    { seq: 2, label: 'Лист «Второй»', text: 'Прейскурант на арматуру.' },
  ];
  app.store.put('книга.xlsx', info.size, info.mtimeMs, 'ok', null, chunks);
  const answer = await search('прейскурант');
  assert.equal(offsetIn(answer), renderChunks(chunks).indexOf('Прейскурант'));
  assert.match(answer, /\[offset \d+\] Лист «Второй»: /u);
});

test('a document still waiting for recognition gives no offset, because its text will shift', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-offset-deferred');
  const file = path.join(fixture.docs, 'скан.pdf');
  await writeFile(file, 'scan');
  const info = await stat(file);
  app.store.put('скан.pdf', info.size, info.mtimeMs, 'partial', OCR_DEFERRED, [{ seq: 0, label: 'Страница 2', text: 'Текстовый слой накладной.' }]);
  const answer = await search('накладная');
  assert.match(answer, /скан\.pdf/u);
  assert.doesNotMatch(answer, /\[offset/u);
});

test('a fragment found before recognition finished gives no offset into the recognized text', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-offset-race');
  const file = path.join(fixture.docs, 'скан.pdf');
  await writeFile(file, 'scan');
  const info = await stat(file);
  app.store.put('скан.pdf', info.size, info.mtimeMs, 'partial', OCR_DEFERRED, [{ seq: 0, label: 'Страница 2', text: 'Текстовый слой накладной.' }]);
  const resolve = app.indexer.guard.resolve.bind(app.indexer.guard);
  context.mock.method(app.indexer.guard, 'resolve', async (...args: Parameters<typeof resolve>) => {
    const resolved = await resolve(...args);
    if (args[0] === 'скан.pdf' && app.store.get('скан.pdf')?.error === OCR_DEFERRED) {
      await new Promise((done) => setTimeout(done, 5));
      app.store.put('скан.pdf', info.size, info.mtimeMs, 'ok', null, [{ seq: 0, label: 'Страница 1', text: 'Распознанная страница.' }, { seq: 1, label: 'Страница 2', text: 'Текстовый слой накладной.' }]);
    }
    return resolved;
  });
  const answer = await search('накладная');
  assert.match(answer, /скан\.pdf/u);
  assert.doesNotMatch(answer, /\[offset/u);
});

test('a code typed with punctuation matches as a phrase, and its words alone only as a fallback', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-phrase');
  await writeFile(path.join(fixture.docs, 'точный.txt'), 'Позиция ЛП-0419 есть на складе.');
  await writeFile(path.join(fixture.docs, 'порознь.txt'), 'Серия ЛП закончилась, заказ 0419 отменён.');
  await app.indexer.rescan();
  const exact = await search('ЛП-0419');
  assert.match(exact, /точный\.txt/u);
  assert.doesNotMatch(exact, /порознь\.txt/u);
  assert.match(exact, /ЛП-0419/u);
  await rm(path.join(fixture.docs, 'точный.txt'));
  await app.indexer.rescan();
  assert.match(await search('ЛП-0419'), /порознь\.txt/u);
});

test('a search reports a file changed since indexing and reindexes it without waiting for the next pass', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-stale');
  const file = path.join(fixture.docs, 'договор.txt');
  await writeFile(file, 'Старое условие про неустойку.');
  await app.indexer.rescan();
  await writeFile(file, 'Новое условие про рассрочку.');
  await utimes(file, new Date(), new Date(Date.now() + 2000));
  const answer = await search('неустойка');
  assert.doesNotMatch(answer, /договор\.txt|неустойк/iu);
  assert.match(answer, /изменённых после индексации: 1/u);
  assert.match(answer, /повторите поиск/u);
  await app.indexer.ensure('договор.txt', { recognize: false });
  assert.match(await search('рассрочка'), /договор\.txt/u);
  assert.doesNotMatch(await search('неустойка'), /изменённых после индексации/u);
});

test('a search leaves a changed file alone while indexing is paused and says so', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-stale-paused');
  const file = path.join(fixture.docs, 'договор.txt');
  await writeFile(file, 'Старое условие про неустойку.');
  await app.indexer.rescan();
  const indexed = app.store.get('договор.txt')?.mtime_ms;
  app.indexer.setPaused(true);
  await writeFile(file, 'Новое условие.');
  await utimes(file, new Date(), new Date(Date.now() + 2000));
  assert.match(await search('неустойка'), /индексация приостановлена/u);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.store.get('договор.txt')?.mtime_ms, indexed);
});
