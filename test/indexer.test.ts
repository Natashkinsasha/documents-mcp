import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, rm, mkdir, symlink, utimes, copyFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { tempProject, docx, spreadsheet, textPdf, cp1251, pptx, resultText, scannedPdf, projectRoot } from './helpers.js';
import { EMPTY_FILE, OCR_DEFERRED } from '../src/types.js';

test('indexer extracts generated documents, tracks changes/deletions, hides excluded data and survives failures', async (context) => {
  const fixture = await tempProject('indexer');
  fixture.config.ignore = ['**/*.bak'];
  fixture.config.maxFileBytes = 50_000;
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await mkdir(path.join(fixture.docs, 'Папка'));
  await writeFile(path.join(fixture.docs, 'Договор.txt'), 'Договор поставки насосов.\nУсловия договора: оплата в течение 30 дней.');
  await writeFile(path.join(fixture.docs, 'старый.txt'), cp1251('Условия договора поставки. Стоимость оборудования.'));
  await writeFile(path.join(fixture.docs, '.secret.txt'), 'Секретный договор');
  await writeFile(path.join(fixture.docs, 'ignored.bak'), 'Секретный договор');
  await writeFile(path.join(fixture.docs, 'unsupported.bin'), 'binary');
  await writeFile(path.join(fixture.docs, 'unsupported.png'), 'not an image');
  await writeFile(path.join(fixture.docs, 'broken.docx'), 'broken');
  await writeFile(path.join(fixture.docs, 'large.txt'), Buffer.alloc(50_001, 'a'));
  await docx(path.join(fixture.docs, 'Папка', 'Таблица.docx'));
  for (const extension of ['xlsx', 'xls', 'ods'] as const) await spreadsheet(path.join(fixture.docs, `Цены.${extension}`), extension);
  await pptx(path.join(fixture.docs, 'Поставка.pptx'));
  await textPdf(path.join(fixture.docs, 'contract.pdf'));
  await app.indexer.rescan();
  assert.equal(app.store.get('Договор.txt')?.status, 'ok');
  assert.equal(app.store.get('старый.txt')?.status, 'ok');
  assert.match(resultText(await app.tools.call('read_document', { path: 'старый.txt' })), /Стоимость оборудования/u);
  assert.equal(app.store.get('Папка/Таблица.docx')?.status, 'ok', app.store.get('Папка/Таблица.docx')?.error ?? '');
  assert.match(resultText(await app.tools.call('read_document', { path: 'Папка/Таблица.docx' })), /Насос \| 12500/u);
  for (const extension of ['xlsx', 'xls', 'ods']) {
    assert.equal(app.store.get(`Цены.${extension}`)?.status, 'ok', app.store.get(`Цены.${extension}`)?.error ?? '');
    const text = resultText(await app.tools.call('read_document', { path: `Цены.${extension}` }));
    assert.match(text, /Лист «Цены»/u); assert.match(text, /12500/u); assert.match(text, /2026-01-15/u);
  }
  assert.match(resultText(await app.tools.call('read_document', { path: 'Поставка.pptx' })), /Слайд 1/u);
  assert.match(resultText(await app.tools.call('read_document', { path: 'contract.pdf' })), /Supply contract/u);
  assert.equal(app.store.get('broken.docx')?.status, 'error');
  assert.equal(app.store.get('large.txt')?.status, 'error');
  assert.equal(app.store.get('unsupported.bin')?.status, 'unsupported');
  assert.equal(app.store.get('unsupported.png')?.status, 'unsupported');
  assert.equal(app.store.get('.secret.txt'), undefined);
  const search = resultText(await app.tools.call('search_documents', { query: 'договору поставка' }));
  assert.match(search, /Договор.txt/u); assert.doesNotMatch(search, /secret|ignored/u);
  assert.match(resultText(await app.tools.call('search_documents', { query: 'договор nonexistent' })), /Договор.txt/u);
  const list = resultText(await app.tools.call('list_folder', {}));
  assert.ok(list.indexOf('Папка/') < list.indexOf('Договор.txt')); assert.match(list, /неподдерживаемый тип/u); assert.match(list, /слишком большой/u);
  assert.equal((await app.tools.call('read_document', { path: 'ignored.bak' })).isError, true);
  await writeFile(path.join(fixture.docs, 'Договор.txt'), 'Новый документ про спецификацию.');
  const searchChanged = resultText(await app.tools.call('search_documents', { query: 'насосов', folder: '' }));
  assert.doesNotMatch(searchChanged, /Договор.txt/u);
  await app.indexer.rescan();
  assert.match(resultText(await app.tools.call('search_documents', { query: 'спецификация' })), /Договор.txt/u);
  await rm(path.join(fixture.docs, 'старый.txt')); await app.indexer.rescan(); assert.equal(app.store.get('старый.txt'), undefined);
  await rm(path.join(fixture.docs, 'Договор.txt'));
  await writeFile(path.join(fixture.directory, 'outside.txt'), 'outside secret');
  await symlink(path.join(fixture.directory, 'outside.txt'), path.join(fixture.docs, 'Договор.txt'));
  assert.doesNotMatch(resultText(await app.tools.call('search_documents', { query: 'спецификация' })), /Договор.txt/u);
  assert.equal((await app.tools.call('read_document', { path: 'Договор.txt' })).isError, true);
  await app.indexer.rescan(); assert.equal(app.store.get('Договор.txt'), undefined);
  assert.match(resultText(await app.tools.call('documents_status', {})), /broken.docx/u);
  await writeFile(path.join(fixture.docs, 'on-demand.txt'), 'Текст без предварительной индексации');
  assert.match(resultText(await app.tools.call('read_document', { path: 'on-demand.txt' })), /без предварительной/u);
  await writeFile(path.join(fixture.docs, 'on-demand.txt'), 'Изменённый текст');
  await utimes(path.join(fixture.docs, 'on-demand.txt'), new Date(), new Date(Date.now() + 1000));
  assert.match(resultText(await app.tools.call('read_document', { path: 'on-demand.txt' })), /Изменённый текст/u);
});

test('a scan indexes text first and recognizes images and scanned PDF pages after all other documents', async (context) => {
  const fixture = await tempProject('recognition-order');
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  const image = path.join(projectRoot, 'test/fixtures/russian.png');
  // Names sort the scans first, so a plain walk would recognize them before the text.
  await copyFile(image, path.join(fixture.docs, 'а-фото.png'));
  await scannedPdf(path.join(fixture.docs, 'б-скан.pdf'), image);
  await writeFile(path.join(fixture.docs, 'я-договор.txt'), 'Договор поставки насосов.');
  const extractor = (app.indexer as unknown as { extractor: { extract(file: string, options?: { recognize?: boolean }): Promise<unknown> } }).extractor;
  const original = extractor.extract.bind(extractor);
  const calls: string[] = [];
  extractor.extract = (file, options) => { calls.push(`${file}:${options?.recognize === false ? 'text' : 'full'}`); return original(file, options); };
  await app.indexer.rescan();
  assert.deepEqual(calls, ['б-скан.pdf:text', 'я-договор.txt:text', 'а-фото.png:full', 'б-скан.pdf:full']);
  assert.equal(app.store.get('а-фото.png')?.status, 'ok');
  assert.equal(app.store.get('б-скан.pdf')?.status, 'ok', app.store.get('б-скан.pdf')?.error ?? '');
  assert.notEqual(app.store.get('б-скан.pdf')?.error, OCR_DEFERRED);
  const status = resultText(await app.tools.call('documents_status', {}));
  assert.match(status, /Ждут распознавания \(сканы и изображения, после остальных\): 0/u);
});

test('reading a document whose scans wait for recognition recognizes them at once', async (context) => {
  const fixture = await tempProject('recognition-on-read');
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await scannedPdf(path.join(fixture.docs, 'скан.pdf'), path.join(projectRoot, 'test/fixtures/russian.png'));
  await app.indexer.ensure('скан.pdf', { recognize: false });
  assert.equal(app.store.get('скан.pdf')?.error, OCR_DEFERRED);
  assert.match(resultText(await app.tools.call('documents_status', {})), /Ждут распознавания \(сканы и изображения, после остальных\): 1/u);
  resultText(await app.tools.call('read_document', { path: 'скан.pdf' }));
  assert.equal(app.store.get('скан.pdf')?.status, 'ok', app.store.get('скан.pdf')?.error ?? '');
});

test('an empty file is reported as empty, not as a damaged document', async (context) => {
  const fixture = await tempProject('empty-file');
  const app = await createApp(fixture.config, { logger: () => {} });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await writeFile(path.join(fixture.docs, 'Устав.doc'), '');
  await app.indexer.rescan();
  assert.equal(app.store.get('Устав.doc')?.status, 'unsupported');
  assert.equal(app.store.get('Устав.doc')?.error, EMPTY_FILE);
  assert.doesNotMatch(resultText(await app.tools.call('documents_status', {})), /Устав\.doc/u);
  assert.match(resultText(await app.tools.call('read_document', { path: 'Устав.doc' })), /Файл пустой/u);
});
