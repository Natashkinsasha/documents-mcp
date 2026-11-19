import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { nameSimilarity } from '../src/paths.js';
import { NOT_FOUND } from '../src/types.js';
import { resultText, tempProject } from './helpers.js';

async function archive(context: TestContext, prefix: string) {
  const fixture = await tempProject(prefix);
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await mkdir(path.join(fixture.docs, 'Объекты', 'Тендер (Лесная 12)', 'поставщики', 'Альфа'), { recursive: true });
  await mkdir(path.join(fixture.docs, 'Объекты', 'Смета (Лесная 12)'));
  await mkdir(path.join(fixture.docs, 'Объекты', 'Садовая 3'));
  await mkdir(path.join(fixture.docs, '.Объекты скрытые'));
  await writeFile(path.join(fixture.docs, 'Объекты', 'Тендер (Лесная 12)', 'поставщики', 'Альфа', 'счёт.txt'), 'Счёт');
  await writeFile(path.join(fixture.docs, 'Объекты', 'Договор поставки.txt'), 'Договор');
  await app.indexer.rescan();
  const caseInsensitive = await access(path.join(fixture.docs, 'объекты')).then(() => true, () => false);
  return { app, fixture, caseInsensitive };
}
const refusal = async (app: Awaited<ReturnType<typeof archive>>['app'], tool: string, input: object) => {
  const result = await app.tools.call(tool, input);
  assert.equal(result.isError, true);
  return resultText(result);
};

test('a shortened folder name leads to the whole existing path', async (context) => {
  const { app } = await archive(context, 'hint-shortened');
  const text = await refusal(app, 'list_folder', { path: 'Объекты/Лесная 12/поставщики/Альфа' });
  assert.ok(text.startsWith(NOT_FOUND));
  assert.match(text, /Существующая часть пути: Объекты\//u);
  const lines = text.split('\n');
  assert.equal(lines[3], '- Объекты/Тендер (Лесная 12)/поставщики/Альфа/ — папка');
  assert.equal(lines[4], '- Объекты/Смета (Лесная 12)/ — папка, остаток запрошенного пути в ней не найден');
  assert.doesNotMatch(text, /Садовая/u);
  assert.match(resultText(await app.tools.call('list_folder', { path: 'Объекты/Тендер (Лесная 12)/поставщики/Альфа' })), /счёт\.txt/u);
});

test('reading and searching get the same hint, with files named as files', async (context) => {
  const { app, caseInsensitive } = await archive(context, 'hint-tools');
  assert.match(await refusal(app, 'read_document', { path: 'Объекты/договор  поставки.TXT' }), /- Объекты\/Договор поставки\.txt — файл/u);
  // On a case-insensitive disk (Windows, macOS) the folder exists under any case, so search runs in it.
  if (caseInsensitive) assert.match(resultText(await app.tools.call('search_documents', { query: 'счёт', folder: 'объекты' })), /Объекты\/Тендер \(Лесная 12\)\/поставщики\/Альфа\/счёт\.txt/u);
  else assert.match(await refusal(app, 'search_documents', { query: 'счёт', folder: 'объекты' }), /- Объекты\/ — папка/u);
});

test('a path with nothing similar points to the part that exists', async (context) => {
  const { app } = await archive(context, 'hint-none');
  const text = await refusal(app, 'list_folder', { path: 'Объекты/Квитанции/2020' });
  assert.match(text, /Существующая часть пути: Объекты\//u);
  assert.match(text, /list_folder/u);
  assert.doesNotMatch(text, /Похожие пути/u);
  assert.equal(await refusal(app, 'list_folder', { path: 'Квитанции' }), NOT_FOUND);
});

test('hidden, ignored and escaping entries stay indistinguishable from missing ones', async (context) => {
  const { app, fixture } = await archive(context, 'hint-hidden');
  await writeFile(path.join(fixture.directory, 'Объекты снаружи.txt'), 'outside');
  await symlink(path.join(fixture.directory, 'Объекты снаружи.txt'), path.join(fixture.docs, 'Объекты снаружи.txt'));
  const hidden = await refusal(app, 'list_folder', { path: '.Объекты скрытые' });
  const missing = await refusal(app, 'list_folder', { path: '.Объекты скрытыя' });
  assert.doesNotMatch(hidden, /скрытые\/|снаружи/u);
  assert.deepEqual(hidden.split('\n').slice(1), missing.split('\n').slice(1));
  assert.equal(await refusal(app, 'list_folder', { path: '../Объекты' }), NOT_FOUND);
});

test('names match across case, ё, punctuation and small typos, but not on one common word', () => {
  assert.equal(nameSimilarity('СЧЁТ-1', 'счет 1'), 1);
  assert.ok(nameSimilarity('Лесная 12', 'Тендер (Лесная 12)') >= 0.6);
  assert.ok(nameSimilarity('Поставщики', 'Поставшики') >= 0.6);
  assert.ok(nameSimilarity('Договор аренды', 'Договор поставки') < 0.6);
});
