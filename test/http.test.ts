import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { Tools } from '../src/tools.js';
import { BODY_LIMIT } from '../src/http.js';
import { writeSchemas } from '../src/mutations.js';
import { tempProject, resultText } from './helpers.js';

test('real SDK HTTP client: authentication, tools, search/read paging, Russian isError and stateless transport', async (context) => {
  const fixture = await tempProject('http'); fixture.config.port = 0;
  const logs: Record<string, unknown>[] = [];
  const app = await createApp(fixture.config, { logger: (entry) => { logs.push(entry); } });
  const source = 'Договор поставки.\nУсловия договора и стоимость.\n'.repeat(100);
  await writeFile(path.join(fixture.docs, 'Договор.txt'), source);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  context.after(async () => { await client.close(); await app.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await app.start(); await app.indexer.rescan();
  const address = app.http.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${fixture.config.token}` };
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
  for (const token of [null, 'bad-token']) {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, 401); assert.equal(response.headers.get('www-authenticate'), 'Bearer'); assert.equal((await response.json() as { jsonrpc: string }).jsonrpc, '2.0');
    const rejected = new Client({ name: 'unauthorized', version: '1.0.0' });
    await assert.rejects(rejected.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } })));
    await rejected.close();
  }
  for (const method of ['GET', 'DELETE']) assert.equal((await fetch(`${base}/mcp`, { method, headers })).status, 405);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers, body: 'x'.repeat(BODY_LIMIT + 1) })).status, 413);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers, body: '{' })).status, 400);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  const listed = await client.listTools(); assert.equal(listed.tools.length, 11);
  for (const tool of listed.tools) {
    const write = Object.hasOwn(writeSchemas, tool.name);
    assert.equal(tool.annotations?.readOnlyHint, !write); assert.equal(tool.annotations?.destructiveHint, write && !['create_folder', 'list_trash'].includes(tool.name));
    assert.equal(tool.annotations?.idempotentHint, !write || tool.name === 'create_folder'); assert.equal(tool.annotations?.openWorldHint, false);
    assert.ok((tool.description?.length ?? 0) < 900); assert.match(tool.title ?? '', /[А-Яа-я]/u);
  }
  assert.match(client.getInstructions() ?? '', /данные/u);
  const capabilities = client.getServerCapabilities(); assert.equal(capabilities?.resources, undefined); assert.equal(capabilities?.prompts, undefined);
  assert.match(resultText(await client.callTool({ name: 'search_documents', arguments: { query: 'договору поставка' } })), /Договор.txt/u);
  const first = resultText(await client.callTool({ name: 'read_document', arguments: { path: 'Договор.txt', limit: 17 } }));
  assert.ok(first.includes(source.slice(0, 17))); assert.match(first, /offset=17/u);
  const second = resultText(await client.callTool({ name: 'read_document', arguments: { path: 'Договор.txt', offset: 17, limit: 19 } }));
  assert.ok(second.includes(source.slice(17, 36))); assert.match(second, /offset=36/u);
  for (const request of [
    { name: 'read_document', arguments: { path: '../outside' } }, { name: 'read_document', arguments: { path: 'absent' } },
    { name: 'read_document', arguments: { path: 'Договор.txt', offset: 100000 } }, { name: 'read_document', arguments: { path: 'Договор.txt', limit: 60001 } },
    { name: 'search_documents', arguments: { query: 'договор', limit: 31 } }, { name: 'unknown', arguments: {} },
  ]) {
    const result = await client.callTool(request); assert.equal(result.isError, true); assert.match(resultText(result), /[А-Яа-я]/u);
  }
  assert.match(resultText(await client.callTool({ name: 'list_folder', arguments: {} })), /Договор.txt/u);
  assert.match(resultText(await client.callTool({ name: 'documents_status', arguments: {} })), /Готово: 1/u);
  const largeWrite = await client.callTool({ name: 'write_document', arguments: { path: 'large-http.txt', content: `${' '.repeat(1_100_000)}Большой HTTP документ` } });
  assert.ok(!largeWrite.isError, resultText(largeWrite));
  assert.equal((await app.tools.call('delete_path', { path: 'large-http.txt' })).isError, undefined);
  assert.ok(logs.some((entry) => entry.tool === 'read_document' && typeof entry.duration_ms === 'number'));
  assert.ok(!JSON.stringify(logs).includes(fixture.config.token)); assert.ok(!JSON.stringify(logs).includes('Условия договора'));
  const ensure = app.indexer.ensure.bind(app.indexer);
  let completed = false;
  app.indexer.ensure = async (file) => { await new Promise((resolve) => setTimeout(resolve, 50)); await ensure(file); completed = true; };
  const quickTools = new Tools(app.indexer, 5);
  const timed = await quickTools.call('read_document', { path: 'Договор.txt' });
  assert.equal(timed.isError, undefined); assert.match(resultText(timed), /Состояние: обрабатывается/u);
  await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(completed, true);
});
