import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { renderChunks } from '../src/index/text.js';
import { Store } from '../src/index/store.js';
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
  // The match sits deep inside its chunk, so the chunk's start alone would miss it with a small limit.
  const body = `${'Вводная строка без нужного слова.\n'.repeat(330)}Гарантия на насос составляет два года.\n${'Заключительная строка.\n'.repeat(300)}`;
  await writeFile(path.join(fixture.docs, 'длинный.txt'), body);
  await app.indexer.rescan();
  const offset = offsetIn(await search('гарантия'));
  assert.ok(offset > 0);
  const read = resultText(await app.tools.call('read_document', { path: 'длинный.txt', offset, limit: 300 }));
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

test('words written together but apart in the text still need all of them before any one will do', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-any-order');
  await writeFile(path.join(fixture.docs, 'договор.txt'), 'Пункт 4, подпункт 2: договор поставки продлён.');
  await writeFile(path.join(fixture.docs, 'шум.txt'), 'Пункт меню и договор аренды.');
  await app.indexer.rescan();
  for (const query of ['пункт 4.2', 'договор,поставка']) {
    const answer = await search(query);
    assert.match(answer, /договор\.txt/u);
    assert.doesNotMatch(answer, /шум\.txt/u);
  }
});

test('a search reports a file changed since indexing and starts a pass for it', async (context) => {
  const { app, fixture, search } = await searchApp(context, 'search-stale');
  const file = path.join(fixture.docs, 'договор.txt');
  await writeFile(file, 'Старое условие про неустойку.');
  await app.indexer.rescan();
  await writeFile(file, 'Новое условие про рассрочку.');
  await utimes(file, new Date(), new Date(Date.now() + 2000));
  const ensure = context.mock.method(app.indexer, 'ensure');
  const answer = await search('неустойка');
  assert.doesNotMatch(answer, /договор\.txt|неустойк|Ничего не найдено/iu);
  assert.match(answer, /Совпадения есть только в файлах, изменённых после индексации: 1/u);
  assert.match(answer, /обходе папки/u);
  // The pass, not the search, queues the file: in its usual order, behind what agents are reading.
  assert.ok(ensure.mock.calls.every((call) => call.arguments[1]?.urgent !== true));
  await app.indexer.rescan();
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
  assert.equal(app.indexer.scanning, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.store.get('договор.txt')?.mtime_ms, indexed);
});

test('an index made before chunks kept their start gets it on opening', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'search-migrate-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'index.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE documents (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, status TEXT NOT NULL, error TEXT, chars INTEGER NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE, seq INTEGER NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(path, seq));
    CREATE VIRTUAL TABLE chunk_fts USING fts5(name_tokens, body_tokens, tokenize='unicode61');
    INSERT INTO documents VALUES ('a.pdf', 1, 1, 'ok', NULL, 0, '2026-01-01T00:00:00.000Z');
    INSERT INTO chunks VALUES (1, 'a.pdf', 0, 'Страница 1', 'Вступление.'), (2, 'a.pdf', 1, 'Страница 2', 'Прейскурант.');
    INSERT INTO chunk_fts (rowid, name_tokens, body_tokens) VALUES (1, 'a pdf', 'вступлен'), (2, 'a pdf', 'прейскурант');
  `);
  old.close();
  const store = new Store(file);
  context.after(() => store.close());
  const chunks = [{ label: 'Страница 1', text: 'Вступление.' }, { label: 'Страница 2', text: 'Прейскурант.' }];
  assert.equal([...store.search('прейскурант', '', 'AND')][0]?.start, renderChunks(chunks).indexOf('Прейскурант'));
});
