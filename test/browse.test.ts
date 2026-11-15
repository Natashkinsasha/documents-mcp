import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, rm, symlink, rename, readFile, utimes } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/http.js';
import { Browser, BROWSE_MAX_BYTES, fileVersion, type BrowseListing } from '../src/browse.js';
import { PathGuard } from '../src/paths.js';
import type { Tools } from '../src/tools.js';
import type { Config } from '../src/config.js';
import { tempProject } from './helpers.js';

async function serve(context: TestContext, config: Config) {
  const server = createHttpServer(config, undefined as unknown as Tools, () => {}, new Browser(new PathGuard(config.docsRoot, config.ignore), config));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${config.token}` };
  const get = (route: string, extra: Record<string, string> = {}, method = 'GET') => fetch(`${base}${route}`, { method, headers: { ...headers, ...extra } });
  const list = async (folder: string, offset = 0) => {
    const response = await get(`/browse/files?path=${encodeURIComponent(folder)}&offset=${offset}`);
    assert.equal(response.status, 200, folder);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return await response.json() as BrowseListing;
  };
  return { base, headers, get, list };
}

async function errorBody(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u);
  const body = await response.json() as { error: string; code: string };
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
  assert.equal(body.code, code); assert.match(body.error, /[А-Яа-я]/u);
  return body;
}

test('browse API: auth, Origin, methods, query validation and untouched old routes', async (context) => {
  const fixture = await tempProject('browse-auth');
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(path.join(fixture.docs, 'a.txt'), 'abc');
  const { base, get } = await serve(context, fixture.config);
  for (const route of ['/browse/files', `/browse/file?path=a.txt&version=${'0'.repeat(64)}`]) {
    for (const authorization of [undefined, 'Bearer bad-token', `Basic ${fixture.config.token}`]) {
      const response = await fetch(`${base}${route}`, { headers: authorization ? { Authorization: authorization } : {} });
      await errorBody(response, 401, 'invalid_request'); assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    }
    await errorBody(await get(route, { Origin: 'https://untrusted.invalid' }), 403, 'invalid_request');
    await errorBody(await get(route, { Origin: '' }), 403, 'invalid_request');
    for (const method of ['POST', 'DELETE', 'PUT']) {
      const response = await get(route, {}, method);
      await errorBody(response, 405, 'invalid_request'); assert.equal(response.headers.get('allow'), 'GET');
    }
  }
  for (const query of [
    '/browse/files?offset=-1', '/browse/files?offset=abc', '/browse/files?offset=01', '/browse/files?offset=1.5', '/browse/files?offset=99999999999',
    '/browse/files?path=a&path=b', '/browse/files?extra=1', `/browse/files?path=${'a'.repeat(4097)}`,
    '/browse/file', '/browse/file?path=a.txt', '/browse/file?version=' + '0'.repeat(64), '/browse/file?path=a.txt&version=xyz',
    `/browse/file?path=a.txt&version=${'A'.repeat(64)}`, `/browse/file?path=a.txt&version=${'0'.repeat(64)}&offset=0`,
  ]) await errorBody(await get(query), 400, 'invalid_request');
  assert.deepEqual((await (await get('/browse/files')).json() as BrowseListing).entries.map((entry) => entry.name), ['a.txt']);
  const rpc = await get('/browse'); assert.equal(rpc.status, 404); assert.equal((await rpc.json() as { jsonrpc: string }).jsonrpc, '2.0');
  const mcp = await get('/mcp'); assert.equal(mcp.status, 405); assert.equal((await mcp.json() as { jsonrpc: string }).jsonrpc, '2.0');
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
});

test('browse API: listing order, exact sizes, versions and exclusions', async (context) => {
  const fixture = await tempProject('browse-list');
  fixture.config.ignore = ['*.tmp', 'Архив'];
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const outside = path.join(fixture.directory, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'secret.txt'), 'secret');
  for (const folder of ['Папка 10', 'Папка 2', 'node_modules', '.git', 'Архив', '.documents-mcp-trash/1']) await mkdir(path.join(fixture.docs, folder), { recursive: true });
  await writeFile(path.join(fixture.docs, 'б.txt'), 'Привет');
  await writeFile(path.join(fixture.docs, 'а 10.txt'), '');
  await writeFile(path.join(fixture.docs, 'а 9.txt'), 'x');
  await writeFile(path.join(fixture.docs, 'Папка 2', 'вложенный.txt'), 'да');
  for (const hidden of ['.env', '~$lock.docx', 'Thumbs.db', 'черновик.tmp', 'Архив/a.txt']) await writeFile(path.join(fixture.docs, hidden), 'hidden');
  await symlink(path.join(fixture.docs, 'б.txt'), path.join(fixture.docs, 'ссылка.txt'));
  await symlink(path.join(fixture.docs, 'Папка 2'), path.join(fixture.docs, 'ссылка-папка'));
  await symlink(outside, path.join(fixture.docs, 'наружу'));
  await symlink(path.join(outside, 'secret.txt'), path.join(fixture.docs, 'secret.txt'));
  const { get, list } = await serve(context, fixture.config);

  const root = await list('');
  assert.deepEqual(root, {
    path: '',
    entries: [
      { name: 'Папка 2', path: 'Папка 2', kind: 'directory', size: null, version: null },
      { name: 'Папка 10', path: 'Папка 10', kind: 'directory', size: null, version: null },
      { name: 'а 9.txt', path: 'а 9.txt', kind: 'file', size: 1, version: root.entries[2]!.version },
      { name: 'а 10.txt', path: 'а 10.txt', kind: 'file', size: 0, version: root.entries[3]!.version },
      { name: 'б.txt', path: 'б.txt', kind: 'file', size: Buffer.byteLength('Привет'), version: root.entries[4]!.version },
    ],
    nextOffset: null,
  });
  for (const entry of root.entries.filter((item) => item.kind === 'file')) assert.match(entry.version!, /^[0-9a-f]{64}$/u);
  assert.equal(new Set(root.entries.map((entry) => entry.version)).size, 4);
  assert.deepEqual(await list('Папка 2'), { path: 'Папка 2', entries: [{ name: 'вложенный.txt', path: 'Папка 2/вложенный.txt', kind: 'file', size: 4, version: (await list('Папка 2')).entries[0]!.version }], nextOffset: null });
  assert.equal((await list('./Папка 2/')).path, 'Папка 2');
  assert.deepEqual(await list('Папка 10'), { path: 'Папка 10', entries: [], nextOffset: null });

  for (const folder of ['..', '../outside', '/etc', fixture.docs, 'C:/Windows', 'Папка 2\\..', 'Папка 2/../..', 'нет', 'б.txt', 'ссылка-папка', 'наружу', 'node_modules', '.git', 'Архив', '.documents-mcp-trash', 'a\0b']) {
    const body = await errorBody(await get(`/browse/files?path=${encodeURIComponent(folder)}`), 404, 'file_missing');
    assert.ok(!JSON.stringify(body).includes(fixture.directory));
  }
});

test('browse API: pagination by 200 entries with numeric order', async (context) => {
  const fixture = await tempProject('browse-page');
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await mkdir(path.join(fixture.docs, 'много'));
  for (let index = 1; index <= 450; index++) await writeFile(path.join(fixture.docs, 'много', `f${index}.txt`), String(index));
  await mkdir(path.join(fixture.docs, 'много', 'я-папка'));
  const { list } = await serve(context, fixture.config);
  const first = await list('много');
  assert.equal(first.entries.length, 200); assert.equal(first.nextOffset, 200);
  assert.deepEqual(first.entries.slice(0, 4).map((entry) => entry.name), ['я-папка', 'f1.txt', 'f2.txt', 'f3.txt']);
  const second = await list('много', 200);
  assert.equal(second.entries.length, 200); assert.equal(second.nextOffset, 400);
  assert.equal(second.entries[0]!.name, 'f200.txt');
  const last = await list('много', 400);
  assert.equal(last.entries.length, 51); assert.equal(last.nextOffset, null);
  assert.equal(last.entries.at(-1)!.name, 'f450.txt');
  const names = [...first.entries, ...second.entries, ...last.entries].map((entry) => entry.name);
  assert.equal(new Set(names).size, 451);
  assert.deepEqual(await list('много', 1000), { path: 'много', entries: [], nextOffset: null });
});

test('browse API: original bytes by version, changed versions, symlinks and size limits', async (context) => {
  const fixture = await tempProject('browse-file');
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 255, 0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e]);
  await mkdir(path.join(fixture.docs, 'Документы'));
  const file = path.join(fixture.docs, 'Документы', 'скан "1".pdf');
  await writeFile(file, bytes);
  await writeFile(path.join(fixture.docs, 'big.bin'), Buffer.alloc(64, 7));
  await symlink(file, path.join(fixture.docs, 'ссылка.pdf'));
  const { get, list } = await serve(context, fixture.config);
  const entry = (await list('Документы')).entries[0]!;
  const fetchFile = (relative: string, version: string) => get(`/browse/file?path=${encodeURIComponent(relative)}&version=${version}`);

  const response = await fetchFile(entry.path, entry.version!);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.ok(![...response.headers.values()].some((value) => value.includes('скан') || value.includes('Документы')));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  await errorBody(await fetchFile(entry.path, 'f'.repeat(64)), 409, 'file_changed');
  for (const relative of ['Документы', 'нет.pdf', '../outside', '/etc/passwd', 'ссылка.pdf', 'Документы/../../x']) await errorBody(await fetchFile(relative, entry.version!), 404, 'file_missing');

  await writeFile(file, Buffer.from(bytes).reverse());
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  await errorBody(await fetchFile(entry.path, entry.version!), 409, 'file_changed');
  const fresh = (await list('Документы')).entries[0]!;
  assert.notEqual(fresh.version, entry.version);
  assert.deepEqual(Buffer.from(await (await fetchFile(fresh.path, fresh.version!)).arrayBuffer()), Buffer.from(bytes).reverse());
  const replacement = path.join(fixture.docs, 'Документы', 'tmp-replacement');
  await writeFile(replacement, Buffer.from(bytes).reverse()); await rename(replacement, file);
  await errorBody(await fetchFile(fresh.path, fresh.version!), 409, 'file_changed');
  const latest = (await list('Документы')).entries[0]!;
  await rm(file); await symlink(path.join(fixture.docs, 'big.bin'), file);
  await errorBody(await fetchFile(latest.path, latest.version!), 404, 'file_missing');

  const big = (await list('')).entries.find((item) => item.name === 'big.bin')!;
  assert.equal(big.size, 64);
  const limited = { ...fixture.config, maxFileBytes: 63 };
  const small = await serve(context, limited);
  await errorBody(await small.get(`/browse/file?path=big.bin&version=${big.version}`), 413, 'file_too_large');
  assert.equal(new Browser(new PathGuard(fixture.docs), { maxFileBytes: 1024 * 1024 * 1024 }).maxBytes, BROWSE_MAX_BYTES);
  assert.equal(new Browser(new PathGuard(fixture.docs), { maxFileBytes: 1000 }).maxBytes, 1000);
});

test('browse API: file version covers inode, size, mtime and ctime', () => {
  const base = { dev: 1, ino: 2, size: 3, mtimeMs: 4.5, ctimeMs: 6.25 };
  const version = fileVersion(base);
  assert.match(version, /^[0-9a-f]{64}$/u);
  assert.equal(fileVersion({ ...base }), version);
  for (const change of [{ dev: 9 }, { ino: 9 }, { size: 9 }, { mtimeMs: 4.6 }, { ctimeMs: 6.26 }]) assert.notEqual(fileVersion({ ...base, ...change }), version);
});

test('browse API in READ_ONLY mode through the app: listing and bytes work, MCP tools unchanged, nothing written', async (context) => {
  const fixture = await tempProject('browse-readonly');
  fixture.config.port = 0; fixture.config.readOnly = true;
  await writeFile(path.join(fixture.docs, 'Отчёт.txt'), 'Отчёт за ноябрь');
  const app = await createApp(fixture.config, { logger: () => {} });
  const client = new Client({ name: 'browse-test', version: '1.0.0' });
  context.after(async () => { await client.close(); await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await app.start();
  const base = `http://127.0.0.1:${(app.http.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${fixture.config.token}` };
  const listing = await (await fetch(`${base}/browse/files?path=`, { headers })).json() as BrowseListing;
  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.size]), [['Отчёт.txt', Buffer.byteLength('Отчёт за ноябрь')]]);
  const file = await fetch(`${base}/browse/file?path=${encodeURIComponent('Отчёт.txt')}&version=${listing.entries[0]!.version}`, { headers });
  assert.equal(file.status, 200); assert.equal(await file.text(), 'Отчёт за ноябрь');
  assert.equal(await readFile(path.join(fixture.docs, 'Отчёт.txt'), 'utf8'), 'Отчёт за ноябрь');
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['documents_status', 'list_folder', 'read_document', 'search_documents']);
});
