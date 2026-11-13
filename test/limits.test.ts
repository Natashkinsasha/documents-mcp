import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { tempProject, resultText } from './helpers.js';

test('folder listings cap output and sort numerically', async (context) => {
  const fixture = await tempProject('listing');
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await mkdir(path.join(fixture.docs, 'Папка'));
  await Promise.all(Array.from({ length: 505 }, (_, index) => writeFile(path.join(fixture.docs, `Файл${index + 1}.bin`), '')));
  const text = resultText(await app.tools.call('list_folder', {}));
  assert.match(text, /Не показано записей: 6/u);
  assert.ok(text.indexOf('Папка/') < text.indexOf('Файл1.bin'));
  assert.ok(text.indexOf('Файл2.bin') < text.indexOf('Файл10.bin'));
  assert.ok(text.length < 200000);
});

test('rescan is single-flight, concurrent reads share extraction and partial status is transparent', async (context) => {
  const fixture = await tempProject('concurrency');
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await writeFile(path.join(fixture.docs, 'new.txt'), 'Договор поставки для проверки');
  const first = app.indexer.rescan(); assert.equal(app.indexer.rescan(), first);
  const reads = await Promise.all([app.tools.call('read_document', { path: 'new.txt' }), app.tools.call('read_document', { path: 'new.txt' })]);
  await first;
  assert.equal(reads[0]?.isError, undefined); assert.equal(reads[1]?.isError, undefined);
  assert.equal(app.store.all().length, 1);
  const row = app.store.get('new.txt')!;
  app.store.put(row.path, row.size, row.mtime_ms, 'partial', 'Достигнут предел страниц для распознавания.', app.store.chunks(row.path));
  assert.match(resultText(await app.tools.call('read_document', { path: row.path })), /прочитан частично/u);
  assert.match(resultText(await app.tools.call('documents_status', {})), /Прочитаны частично: 1/u);
});
