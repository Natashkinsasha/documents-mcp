import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/app.js';
import { createMcpServer } from '../src/mcp.js';
import { writeInfo, writeSchemas } from '../src/mutations.js';
import { RETENTION_MS, Trash } from '../src/trash.js';
import { PathGuard } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
import { createXlsx } from '../src/write-formats.js';
import { extractExcel } from '../src/extract/excel.js';
import { tempProject, cp1251, resultText } from './helpers.js';

test('write tools, backups, encodings, paths, concurrency and immediate search', async (context) => {
  const fixture = await tempProject('mutations');
  fixture.config.ignore = ['**/*.bak', 'blocked/**', '**/skip-*', 'restricted/*.txt'];
  let now = Date.parse('2026-11-13T12:00:00.000Z');
  const logs: Record<string, unknown>[] = [];
  const app = await createApp(fixture.config, { logger: (entry) => logs.push(entry), now: () => now });
  context.after(async () => { await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await app.tools.call(name, args);
    assert.ok(!result.isError, resultText(result));
    return resultText(result);
  };
  const fail = async (name: string, args: Record<string, unknown>, pattern?: RegExp) => {
    const result = await app.tools.call(name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args).slice(0, 200)}: ${resultText(result)}`);
    if (pattern) assert.match(resultText(result), pattern);
  };
  const modified = async (file: string) => new Date((await stat(path.join(fixture.docs, file))).mtimeMs).toISOString();

  await context.test('folders and UTF-8 writes are idempotent or explicitly overwritten', async () => {
    await call('create_folder', { path: 'Работа/Вложено' });
    await call('create_folder', { path: 'Работа/Вложено' });
    await call('write_document', { path: 'Работа/план.md', content: '# План\nУникальное оборудование' });
    const stamp = await modified('Работа/план.md');
    assert.match(await call('list_folder', { path: 'Работа' }), new RegExp(stamp.replaceAll('.', '\\.')));
    assert.match(await call('read_document', { path: 'Работа/план.md' }), /редактируемый текст/u);
    await fail('create_folder', { path: 'Работа/план.md' });
    await fail('write_document', { path: 'Работа/план.md', content: 'wrong' }, /уже существует/u);
    await fail('write_document', { path: 'Работа/план.md', content: 'wrong', overwrite: true }, /Перечитайте/u);
    await fail('write_document', { path: 'Работа/план.md', content: 'wrong', overwrite: true, expected_modified: '2000-01-01T00:00:00.000Z' }, /Перечитайте/u);
    assert.match(await call('search_documents', { query: 'уникальное оборудование' }), /Работа\/план.md/u);
    await call('write_document', { path: 'Работа/план.md', content: 'Новейший спектрометр', overwrite: true, expected_modified: stamp });
    assert.match(await call('search_documents', { query: 'спектрометр' }), /план.md/u);
    assert.doesNotMatch(await call('search_documents', { query: 'уникальное' }), /план.md/u);
    const entries = await app.indexer.trash.list();
    assert.equal(entries[0]!.reason, 'replaced');
    assert.match(await readFile(app.indexer.trash.item(entries[0]!.id), 'utf8'), /Уникальное/u);
  });

  await context.test('text edits preserve CRLF, encoding/BOM and mode; multi-edit failures are atomic', async () => {
    const originals = [
      ['cp.txt', cp1251('Привет\r\nМир\r\n')],
      ['bom.txt', Buffer.from('\ufeffПривет\r\nМир\r\n')],
      ['le.txt', Buffer.from('\ufeffПривет\r\nМир\r\n', 'utf16le')],
      ['be.txt', Buffer.from('\ufeffПривет\r\nМир\r\n', 'utf16le').swap16()],
    ] as const;
    for (const [name, bytes] of originals) {
      await writeFile(path.join(fixture.docs, name), bytes);
      await chmod(path.join(fixture.docs, name), 0o640);
      const stamp = await modified(name);
      await fail('edit_document', { path: name, expected_modified: stamp, edits: [{ old_text: 'Привет', new_text: 'Изменён' }, { old_text: 'нет', new_text: 'x' }] }, /Правка 2: найдено совпадений 0/u);
      assert.deepEqual(await readFile(path.join(fixture.docs, name)), bytes);
      await fail('edit_document', { path: name, expected_modified: '2000-01-01T00:00:00.000Z', edits: [{ old_text: 'Привет', new_text: 'x' }] }, /Перечитайте/u);
      await call('edit_document', { path: name, expected_modified: stamp, edits: [{ old_text: 'Привет\nМир', new_text: 'Добрый\nДень' }] });
      const after = await readFile(path.join(fixture.docs, name));
      if (name === 'cp.txt') assert.deepEqual(after, cp1251('Добрый\r\nДень\r\n'));
      else assert.deepEqual(after, name === 'bom.txt' ? Buffer.from('\ufeffДобрый\r\nДень\r\n') : name === 'le.txt' ? Buffer.from('\ufeffДобрый\r\nДень\r\n', 'utf16le') : Buffer.from('\ufeffДобрый\r\nДень\r\n', 'utf16le').swap16());
      assert.equal((await stat(path.join(fixture.docs, name))).mode & 0o777, 0o640);
      await call('write_document', { path: name, content: 'Замена', overwrite: true, expected_modified: await modified(name) });
      if (name === 'cp.txt') assert.deepEqual(await readFile(path.join(fixture.docs, name)), cp1251('Замена'));
      else assert.deepEqual((await readFile(path.join(fixture.docs, name))).subarray(0, name === 'bom.txt' ? 3 : 2), bytes.subarray(0, name === 'bom.txt' ? 3 : 2));
    }
    await fail('write_document', { path: 'cp.txt', content: 'emoji 😀', overwrite: true, expected_modified: await modified('cp.txt') }, /windows-1251/u);
    await fail('edit_document', { path: 'cp.txt', expected_modified: await modified('cp.txt'), edits: [{ old_text: 'Замена', new_text: '😀' }] }, /windows-1251/u);
    await call('write_document', { path: 'repeat.txt', content: 'same same' });
    await fail('edit_document', { path: 'repeat.txt', expected_modified: await modified('repeat.txt'), edits: [{ old_text: 'same', new_text: 'one' }] }, /совпадений 2/u);
    await call('edit_document', { path: 'repeat.txt', expected_modified: await modified('repeat.txt'), edits: [{ old_text: 'same', new_text: 'both', replace_all: true }, { old_text: 'both both', new_text: 'complete' }] });
    assert.equal(await readFile(path.join(fixture.docs, 'repeat.txt'), 'utf8'), 'complete');
    await fail('write_document', { path: 'large.txt', content: 'x'.repeat(5_000_001) });
  });

  await context.test('DOCX and XLSX round trip with structure, typing, widths and explicit replacement', async () => {
    await call('write_document', { path: 'report.docx', content: '# Отчёт\n## Подзаголовок\n### Детали\nПривет **жирный** и *курсив*.\n- Первый\n1. Второй\n2. Третий\n| Товар | Цена |\n| --- | --- |\n| Спектрограф | 12500 |' });
    const read = await call('read_document', { path: 'report.docx' });
    for (const word of ['Отчёт', 'Подзаголовок', 'Детали', 'жирный', 'курсив', 'Первый', 'Второй', 'Спектрограф', '12500']) assert.ok(read.includes(word), word);
    assert.match(read, /замена целиком/u);
    const archive = unzipSync(await readFile(path.join(fixture.docs, 'report.docx')));
    const document = strFromU8(archive['word/document.xml']!);
    assert.match(document, /w:b[\s/>]/u); assert.match(document, /w:i[\s/>]/u); assert.match(document, /w:numPr/u); assert.match(document, /w:tbl/u);
    await call('write_document', { path: 'prices.xlsx', content: '## Лист: Цены\n| Товар | Цена | Дата | Скидка |\n| --- | --- | --- | --- |\n| Спектрограф | 12500 | 2026-11-13 | 15% |\n## Лист: Остатки\nКод\tКоличество\nНасос\t4' });
    const xlsx = await call('read_document', { path: 'prices.xlsx' });
    for (const word of ['Цены', 'Остатки', 'Спектрограф', '12500', '2026-11-13', 'Насос']) assert.ok(xlsx.includes(word), word);
    const workbook = XLSX.read(await readFile(path.join(fixture.docs, 'prices.xlsx')), { type: 'buffer', cellDates: true, cellStyles: true });
    assert.equal(workbook.Sheets['Цены']!.B2.t, 'n'); assert.equal(workbook.Sheets['Цены']!.B2.v, 12500);
    assert.equal(workbook.Sheets['Цены']!.C2.t, 'd'); assert.equal(workbook.Sheets['Цены']!.D2.v, 0.15);
    assert.ok(workbook.Sheets['Цены']!['!cols']![0]!.wch! >= 8);
    for (const file of ['report.docx', 'prices.xlsx']) {
      const stamp = await modified(file);
      await fail('write_document', { path: file, content: 'new', overwrite: true, expected_modified: stamp }, /replace_office=true/u);
      await fail('edit_document', { path: file, expected_modified: stamp, edits: [{ old_text: 'Товар', new_text: 'new' }] }, /текстовыми/u);
      await call('write_document', { path: file, content: file.endsWith('xlsx') ? 'Name,Price\nNew,22' : '# Новый отчёт', overwrite: true, expected_modified: stamp, replace_office: true });
    }
    await fail('write_document', { path: 'invalid.xlsx', content: '## Лист: Bad/Name\na,b' }, /имя листа/u);
    for (const extension of ['pdf', 'png', 'doc', 'xls', 'pptx', 'rtf', 'ods']) await fail('write_document', { path: `no.${extension}`, content: 'not supported' }, /Запись доступна/u);
  });

  await context.test('all mutation paths reject traversal, ignored entries, invalid Windows names and symlinks', async () => {
    await writeFile(path.join(fixture.directory, 'outside.txt'), 'outside unchanged');
    await mkdir(path.join(fixture.docs, 'safe'));
    await symlink(path.join(fixture.directory, 'outside.txt'), path.join(fixture.docs, 'outside.txt'));
    await symlink(path.join(fixture.docs, 'safe'), path.join(fixture.docs, 'alias'));
    await symlink(path.join(fixture.docs, 'repeat.txt'), path.join(fixture.docs, 'inside.txt'));
    const rejected = ['', '.', '/', '../escape.txt', '/absolute.txt', 'a\\b', 'a\0b', '.documents-mcp-trash/item', '.hidden', 'a/.secret', '~$word.docx', 'Thumbs.db', 'desktop.ini', 'node_modules/a', 'blocked/file.txt', 'file.bak', 'skip-file.txt', 'CON.txt', 'aux', 'COM1.docx', 'LPT9', 'a:name', 'bad?.txt', 'bad*.txt', 'bad|.txt', 'a<.txt', 'a>.txt', 'a".txt', 'a\u0001', 'tail.', 'tail ', `${'я'.repeat(128)}.txt`, `${'a/'.repeat(501)}file.txt`, 'outside.txt', 'inside.txt', 'alias/new.txt'];
    for (const rejectedPath of rejected) {
      await fail('create_folder', { path: rejectedPath });
      await fail('write_document', { path: rejectedPath, content: 'x' });
      await fail('edit_document', { path: rejectedPath, expected_modified: '2026-11-13T00:00:00.000Z', edits: [{ old_text: 'x', new_text: 'y' }] });
      await fail('delete_path', { path: rejectedPath });
      await fail('move_path', { from: rejectedPath, to: 'destination' });
      await fail('move_path', { from: 'repeat.txt', to: rejectedPath });
    }
    assert.equal(await readFile(path.join(fixture.directory, 'outside.txt'), 'utf8'), 'outside unchanged');
    await call('create_folder', { path: 'mixed' });
    await writeFile(path.join(fixture.docs, 'mixed/.hidden'), 'protected');
    await fail('delete_path', { path: 'mixed' });
    await fail('move_path', { from: 'mixed', to: 'moved-mixed' });
    await call('create_folder', { path: 'projected' });
    await call('write_document', { path: 'projected/file.txt', content: 'protected on arrival' });
    await fail('move_path', { from: 'projected', to: 'restricted' });
    const trash = await app.indexer.trash.list();
    for (const rejectedPath of rejected) await fail('restore_from_trash', { id: trash[0]!.id, to: rejectedPath });
    assert.doesNotMatch(await call('list_folder'), /documents-mcp-trash/u);
    await fail('list_folder', { path: '.documents-mcp-trash' });
    await fail('read_document', { path: `.documents-mcp-trash/${trash[0]!.id}/item` });
  });

  await context.test('move, recursive delete and restore update the index and handle overwrite conflicts', async () => {
    await fail('move_path', { from: 'Работа', to: 'Работа/Вложено/inside' }, /внутрь себя/u);
    await call('move_path', { from: 'Работа', to: 'Архив' });
    assert.match(await call('search_documents', { query: 'спектрометр' }), /Архив\/план.md/u);
    assert.equal(app.store.get('Работа/план.md'), undefined);
    await call('write_document', { path: 'target.txt', content: 'Целевая версия' });
    await fail('move_path', { from: 'repeat.txt', to: 'target.txt' }, /уже существует/u);
    await call('move_path', { from: 'repeat.txt', to: 'target.txt', overwrite: true });
    assert.ok((await app.indexer.trash.list()).some((entry) => entry.reason === 'overwritten by move'));
    const deleted = await call('delete_path', { path: 'Архив' });
    assert.match(deleted, /30 дней/u);
    assert.doesNotMatch(await call('search_documents', { query: 'спектрометр' }), /план.md/u);
    assert.equal(app.store.get('Архив/план.md'), undefined);
    const entry = (await app.indexer.trash.list()).find((item) => item.originalPath === 'Архив')!;
    assert.equal(entry.kind, 'folder');
    assert.ok(entry.size > 0);
    assert.match(await call('list_trash'), /удалён/u);
    await call('restore_from_trash', { id: entry.id });
    assert.match(await call('search_documents', { query: 'спектрометр' }), /Архив\/план.md/u);
    const removal = await call('delete_path', { path: 'target.txt' });
    const id = /id: (\S+)/u.exec(removal)![1]!;
    await call('write_document', { path: 'target.txt', content: 'Конфликтующая версия' });
    await fail('restore_from_trash', { id }, /уже существует/u);
    assert.equal(await readFile(path.join(fixture.docs, 'target.txt'), 'utf8'), 'Конфликтующая версия');
    await call('restore_from_trash', { id, overwrite: true });
    assert.equal(await readFile(path.join(fixture.docs, 'target.txt'), 'utf8'), 'complete');
    const backup = (await app.indexer.trash.list()).find((item) => item.originalPath === 'target.txt' && item.reason === 'replaced')!;
    await call('restore_from_trash', { id: backup.id, to: 'Восстановлено/Вложено/backup.txt' });
    assert.equal(await readFile(path.join(fixture.docs, 'Восстановлено/Вложено/backup.txt'), 'utf8'), 'Конфликтующая версия');
    await fail('write_document', { path: 'renamed.pdf', content: 'x' });
    await writeFile(path.join(fixture.docs, 'test.pdf'), 'read-only format, movable');
    await call('move_path', { from: 'test.pdf', to: 'renamed.pdf' });
    await call('delete_path', { path: 'renamed.pdf' });
  });

  await context.test('concurrent edits and writes serialize; one stale edit fails', async () => {
    await call('write_document', { path: 'concurrent.txt', content: 'original' });
    const stamp = await modified('concurrent.txt');
    const results = await Promise.all(['first', 'second'].map((new_text) => app.tools.call('edit_document', { path: 'concurrent.txt', expected_modified: stamp, edits: [{ old_text: 'original', new_text }] })));
    assert.equal(results.filter((result) => !result.isError).length, 1);
    assert.equal(results.filter((result) => result.isError).length, 1);
    const creates = await Promise.all(['first', 'second'].map((content) => app.tools.call('write_document', { path: 'race.txt', content })));
    assert.equal(creates.filter((result) => !result.isError).length, 1);
    assert.equal((await readdir(fixture.docs)).filter((name) => name.endsWith('.tmp')).length, 0);
    assert.ok(logs.some((entry) => entry.tool === 'edit_document' && entry.result === 'ok' && typeof entry.bytes === 'number'));
    assert.ok(!JSON.stringify(logs).includes('Конфликтующая версия'));
  });

  await context.test('final modification recheck refuses changes made during the backup', async () => {
    await call('write_document', { path: 'external.txt', content: 'Before' });
    const stamp = await modified('external.txt');
    const before = (await app.indexer.trash.list()).length;
    const originalPut = app.indexer.trash.put.bind(app.indexer.trash);
    app.indexer.trash.put = async (...args) => {
      const entry = await originalPut(...args);
      await writeFile(path.join(fixture.docs, 'external.txt'), 'Changed by external editor during backup');
      return entry;
    };
    try { await fail('write_document', { path: 'external.txt', content: 'After', overwrite: true, expected_modified: stamp }, /изменился/u); }
    finally { app.indexer.trash.put = originalPut; }
    assert.equal(await readFile(path.join(fixture.docs, 'external.txt'), 'utf8'), 'Changed by external editor during backup');
    assert.equal((await app.indexer.trash.list()).length, before);
  });

  await context.test('folder overwrites can replace a file and restore it safely', async () => {
    await call('create_folder', { path: 'folder-source' });
    await call('write_document', { path: 'folder-source/inside.txt', content: 'Многослойный рефлектометр' });
    await call('write_document', { path: 'file-target.txt', content: 'Previous file target' });
    await call('move_path', { from: 'folder-source', to: 'file-target.txt', overwrite: true });
    assert.ok((await stat(path.join(fixture.docs, 'file-target.txt'))).isDirectory());
    const removed = await call('delete_path', { path: 'file-target.txt' });
    const id = /id: (\S+)/u.exec(removed)![1]!;
    await call('write_document', { path: 'file-target.txt', content: 'Current conflicting file' });
    await call('restore_from_trash', { id, overwrite: true });
    assert.match(await call('search_documents', { query: 'рефлектометр' }), /file-target.txt\/inside.txt/u);
    await Promise.all([app.indexer.rescan(), call('write_document', { path: 'during-scan.txt', content: 'Новейший дефектоскоп' })]);
    assert.match(await call('search_documents', { query: 'дефектоскоп' }), /during-scan.txt/u);
  });

  await context.test('folder moves re-key indexed chunks without extracting unchanged documents again', async () => {
    await call('create_folder', { path: 'rekey-source' });
    await call('write_document', { path: 'rekey-source/old-name.md', content: 'Рефракционный монохроматор' });
    const chunks = app.store.chunks('rekey-source/old-name.md');
    const extractor = (app.indexer as unknown as { extractor: { extract: (file: string) => Promise<unknown> } }).extractor;
    const original = extractor.extract;
    extractor.extract = async () => { throw new Error('Unexpected extraction during re-key'); };
    try { await call('move_path', { from: 'rekey-source', to: 'rekey-destination' }); }
    finally { extractor.extract = original; }
    assert.deepEqual(app.store.chunks('rekey-destination/old-name.md'), chunks);
    assert.equal(app.store.get('rekey-destination/old-name.md')!.status, 'ok');
    assert.match(await call('search_documents', { query: 'монохроматор' }), /rekey-destination/u);
    assert.equal(app.store.get('rekey-source/old-name.md'), undefined);
    assert.ok(![...app.store.search('source', '', 'AND')].some((hit) => hit.path === 'rekey-destination/old-name.md'));
  });

  await context.test('trash expires and is purged after exactly 30 days using an injected clock', async () => {
    const entries = await app.indexer.trash.list();
    assert.ok(entries.length > 0);
    now += RETENTION_MS - 1;
    assert.equal((await app.indexer.trash.list()).length, entries.length);
    now++;
    await fail('restore_from_trash', { id: entries[0]!.id, to: 'expired.txt' }, /30 дней/u);
    await app.indexer.rescan();
    assert.deepEqual(await readdir(path.join(fixture.docs, '.documents-mcp-trash')), []);
    assert.equal(await call('list_trash'), 'Корзина пуста.');
    assert.ok(!app.store.all().some((row) => row.path.includes('.documents-mcp-trash')));
  });
});

test('trash listing caps at 200 and refuses symlinked entries, metadata and roots', async (context) => {
  const fixture = await tempProject('trash-guard');
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  let now = Date.parse('2026-11-13T12:00:00.000Z');
  const trash = new Trash(new PathGuard(fixture.docs), () => now);
  for (let index = 0; index < 205; index++) {
    await writeFile(path.join(fixture.docs, 'cap.txt'), `entry ${index}`);
    await trash.put('cap.txt', 'deleted');
    now++;
  }
  const entries = await trash.list();
  assert.equal(entries.length, 200);
  assert.equal(entries[0]!.deletedAt, new Date(now - 1).toISOString());
  assert.equal(entries.at(-1)!.deletedAt, new Date(now - 200).toISOString());
  const linkId = '20261113130000000-0000000000000000';
  await symlink(fixture.directory, path.join(trash.directory, linkId));
  await assert.rejects(trash.get(linkId));
  assert.equal((await trash.list()).length, 200);
  const metadataId = '20261113130000000-1111111111111111';
  await mkdir(path.join(trash.directory, metadataId));
  await symlink(path.join(trash.directory, entries[0]!.id, 'meta.json'), path.join(trash.directory, metadataId, 'meta.json'));
  await assert.rejects(trash.get(metadataId));
  const other = path.join(fixture.directory, 'other-root');
  await mkdir(other);
  await writeFile(path.join(other, 'keep.txt'), 'unchanged');
  await symlink(fixture.directory, path.join(other, '.documents-mcp-trash'));
  const unsafeTrash = new Trash(new PathGuard(other));
  await assert.rejects(unsafeTrash.list());
  await assert.rejects(unsafeTrash.put('keep.txt', 'deleted'));
  assert.equal(await readFile(path.join(other, 'keep.txt'), 'utf8'), 'unchanged');
});

test('new spreadsheet ISO dates round trip without a timezone shift', async (context) => {
  const fixture = await tempProject('date-roundtrip');
  const originalTimezone = process.env.TZ;
  context.after(async () => {
    if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone;
    await rm(fixture.directory, { recursive: true, force: true });
  });
  for (const timezone of ['Europe/Minsk', 'America/Los_Angeles', 'UTC']) {
    process.env.TZ = timezone;
    const file = path.join(fixture.docs, 'dates.xlsx');
    await writeFile(file, createXlsx('Дата,Момент\n2026-11-13,2026-11-13T12:34:56Z'));
    const extracted = await extractExcel(file);
    assert.match(extracted.parts[0]!.text, /2026-11-13T00:00:00.000Z\t2026-11-13T12:34:56.000Z/u, timezone);
  }
});

test('MCP discovery, annotations, descriptions and READ_ONLY opt-out', async (context) => {
  const fixture = await tempProject('write-mcp');
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const enabled = await loadConfig({ DOCS_ROOT: fixture.docs, INDEX_DIR: fixture.config.indexDir, MCP_TOKEN: fixture.config.token });
  assert.equal(enabled.readOnly, false);
  const disabled = await loadConfig({ DOCS_ROOT: fixture.docs, INDEX_DIR: fixture.config.indexDir, MCP_TOKEN: fixture.config.token, READ_ONLY: '1' });
  assert.equal(disabled.readOnly, true);
  for (const readOnly of [false, true]) {
    const app = await createApp({ ...fixture.config, readOnly }, { logger: () => {} });
    const server = createMcpServer(app.tools, () => {});
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const listing = await client.listTools();
      assert.equal(listing.tools.length, readOnly ? 4 : 11);
      for (const tool of listing.tools) {
        const write = Object.hasOwn(writeSchemas, tool.name);
        assert.equal(tool.annotations!.readOnlyHint, !write);
        assert.equal(tool.annotations!.openWorldHint, false);
        if (write) {
          assert.equal(tool.annotations!.destructiveHint, !['create_folder', 'list_trash'].includes(tool.name));
          assert.equal(tool.annotations!.idempotentHint, tool.name === 'create_folder');
          assert.ok(tool.description!.length < 900);
        }
      }
      if (readOnly) {
        for (const name of Object.keys(writeInfo)) assert.equal((await client.callTool({ name, arguments: {} })).isError, true);
        await app.indexer.rescan();
        assert.ok(!(await readdir(fixture.docs)).includes('.documents-mcp-trash'));
      }
    } finally { await client.close(); await server.close(); await app.close(); }
  }
});
