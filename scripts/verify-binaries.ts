import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { projectRoot, docx, spreadsheet, textPdf, scannedPdf, resultText } from '../test/helpers.js';

const execute = promisify(execFile);
const target = process.argv[2] ?? 'darwin-arm64';
await mkdir(path.join(projectRoot, 'tmp/verification'), { recursive: true });
const directory = await mkdtemp(path.join(projectRoot, 'tmp/verification', `${target}-writes-`));
const docs = path.join(directory, 'documents'); const index = path.join(directory, 'index'); const work = path.join(directory, 'work');
await Promise.all([docs, index, work].map((name) => mkdir(name, { recursive: true })));
await writeFile(path.join(docs, 'Договор.txt'), 'Договор поставки оборудования. Оплата в течение тридцати дней.');
await docx(path.join(docs, 'Поставка.docx')); await spreadsheet(path.join(docs, 'Цены.xlsx')); await textPdf(path.join(docs, 'Contract.pdf'));
await copyFile(path.join(projectRoot, 'test/fixtures/russian.png'), path.join(docs, 'Скан.png'));
await scannedPdf(path.join(docs, 'Скан.pdf'), path.join(docs, 'Скан.png'));
const binary = path.join(projectRoot, 'release', `documents-mcp-${target}`);
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address(); assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
const name = `documents-mcp-verify-${target}`;
let processHandle: ChildProcess | undefined;
let container = false;
const lines: string[] = [`Verification directory: ${directory}`, `Loopback port: ${port}`];
try {
  if (target === 'darwin-arm64') {
    const localBinary = path.join(work, 'documents-mcp'); await copyFile(binary, localBinary);
    const env = { PATH: '/usr/bin:/bin', DOCS_ROOT: docs, INDEX_DIR: index, MCP_TOKEN: 'verification-token-'.repeat(4), OCR_LANGS: 'rus+bel+eng', PORT: String(port) };
    await assert.rejects(execute('/usr/bin/which', ['node'], { env }), (error: unknown) => (error as { code?: number }).code === 1);
    assert.deepEqual(await readdir(work), ['documents-mcp']); lines.push('Working directory contains only the executable; no external Node on PATH.');
    lines.push((await execute(localBinary, ['--version'], { cwd: work, env })).stdout.trim());
    processHandle = spawn(localBinary, ['run'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const architecture = target === 'linux-arm64' ? 'arm64' : 'amd64';
    lines.push((await execute('docker', ['run', '--rm', '--platform', `linux/${architecture}`, `documents-mcp:debian-${architecture}`, 'sh', '-c', 'if command -v node >/dev/null 2>&1; then exit 1; fi; printf "No external Node on PATH\\n"'])).stdout.trim());
    lines.push((await execute('docker', ['run', '--rm', '--platform', `linux/${architecture}`, '-v', `${binary}:/documents-mcp:ro`, `documents-mcp:debian-${architecture}`, '/documents-mcp', '--version'], { timeout: 60_000 })).stdout.trim());
    await execute('docker', ['run', '-d', '--name', name, '--platform', `linux/${architecture}`, '-v', `${binary}:/documents-mcp:ro`, '-v', `${docs}:/documents:rw`, '-v', `${index}:/index`, '-p', `127.0.0.1:${port}:3000`, '-e', 'DOCS_ROOT=/documents', '-e', 'INDEX_DIR=/index', '-e', 'MCP_TOKEN=verification-token-verification-token-verification-token-verification-token-', '-e', 'OCR_LANGS=rus+bel+eng', '-e', 'HOST=0.0.0.0', `documents-mcp:debian-${architecture}`, '/documents-mcp', 'run']); container = true;
  }
  let log = '';
  processHandle?.stdout?.on('data', (chunk) => { log += String(chunk); }); processHandle?.stderr?.on('data', (chunk) => { log += String(chunk); });
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch {}
    if (processHandle?.exitCode !== null && processHandle?.exitCode !== undefined) throw new Error(`Server exited: ${log}`);
    await delay(500);
  }
  assert.ok(healthy, `Health check failed: ${log}`); lines.push('GET /healthz -> 200 ok');
  const client = new Client({ name: 'standalone-verification', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${'verification-token-'.repeat(4)}` } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, 11); assert.equal(tools.tools.filter((tool) => tool.annotations?.readOnlyHint).length, 4);
    lines.push(`tools/list -> ${tools.tools.map((tool) => tool.name).join(', ')}`);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = resultText(result);
      assert.ok(!result.isError, `${name}: ${text}`);
      lines.push(`${name} ${JSON.stringify(args)}\n${text}`);
      return text;
    };
    for (const file of ['Договор.txt', 'Поставка.docx', 'Цены.xlsx', 'Contract.pdf', 'Скан.pdf', 'Скан.png']) {
      const result = await client.callTool({ name: 'read_document', arguments: { path: file } }); const text = resultText(result);
      assert.ok(!result.isError, `${file}: ${text}`);
      if (file.startsWith('Скан')) assert.match(text, /ДОГОВОР ПОСТАВКИ/u);
      lines.push(`read_document ${JSON.stringify({ path: file })}\n${text}`);
    }
    for (const request of [{ name: 'search_documents', arguments: { query: 'договор поставки' } }, { name: 'list_folder', arguments: {} }, { name: 'documents_status', arguments: {} }]) {
      const result = await client.callTool(request); assert.ok(!result.isError, resultText(result)); lines.push(`${request.name} ${JSON.stringify(request.arguments)}\n${resultText(result)}`);
    }
    await call('create_folder', { path: 'Новые/Проекты' });
    await call('write_document', { path: 'Новые/Проекты/план.md', content: '# Новый план\nПервичная заметка' });
    await call('write_document', { path: 'Новые/Проекты/отчёт.docx', content: '# Созданный отчёт\nТекст **важный** и *курсив*.\n- Проверка\n| Товар | Цена |\n| --- | --- |\n| Спектрограф | 12500 |' });
    await call('write_document', { path: 'Новые/Проекты/цены.xlsx', content: '## Лист: Цены\n| Товар | Цена | Дата | Скидка |\n| --- | --- | --- | --- |\n| Спектрограф | 12500 | 2026-11-13 | 15% |' });
    assert.match(await call('read_document', { path: 'Новые/Проекты/отчёт.docx' }), /Спектрограф \| 12500/u);
    assert.match(await call('read_document', { path: 'Новые/Проекты/цены.xlsx' }), /Спектрограф\t12500\t2026-11-13/u);
    const firstRead = await call('read_document', { path: 'Новые/Проекты/план.md' });
    const expected_modified = /Изменён: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/u.exec(firstRead)![1]!;
    await call('edit_document', { path: 'Новые/Проекты/план.md', expected_modified, edits: [{ old_text: 'Первичная заметка', new_text: 'Квантовый интерферометр проверен' }] });
    assert.match(await call('search_documents', { query: 'интерферометр' }), /Новые\/Проекты\/план.md/u);
    await call('move_path', { from: 'Новые', to: 'Архив' });
    const moved = await call('search_documents', { query: 'интерферометр' });
    assert.match(moved, /Архив\/Проекты\/план.md/u); assert.doesNotMatch(moved, /Новые\/Проекты\/план.md/u);
    const deleted = await call('delete_path', { path: 'Архив/Проекты/план.md' });
    assert.doesNotMatch(await call('search_documents', { query: 'интерферометр' }), /план.md/u);
    const id = /id: (\S+)/u.exec(deleted)![1]!;
    assert.ok((await call('list_trash')).includes(id));
    await call('restore_from_trash', { id });
    assert.match(await call('read_document', { path: 'Архив/Проекты/план.md' }), /Квантовый интерферометр проверен/u);
    assert.match(await call('search_documents', { query: 'интерферометр' }), /Архив\/Проекты\/план.md/u);
    await call('documents_status');
  } finally { await client.close(); }
  const runtime = (await readdir(path.join(index, 'runtime'))).find((name) => /^2\.0\.0-/u.test(name))!;
  const tunnel = target === 'darwin-arm64' ? await execute(path.join(index, 'runtime', runtime, 'cloudflared'), ['--version'], { env: { PATH: '/usr/bin:/bin' } }) : await execute('docker', ['exec', name, `/index/runtime/${runtime}/cloudflared`, '--version']);
  lines.push(tunnel.stdout.trim());
} catch (error) {
  if (container) lines.push((await execute('docker', ['logs', name])).stdout);
  lines.push(`FAILED: ${String(error)}`); throw error;
} finally {
  if (container) await execute('docker', ['rm', '-f', name]);
  if (processHandle && processHandle.exitCode === null) {
    const exit = new Promise<void>((resolve) => processHandle!.once('exit', () => resolve()));
    processHandle.kill('SIGTERM'); const timer = setTimeout(() => processHandle?.kill('SIGKILL'), 10_000);
    await exit; clearTimeout(timer);
    lines.push(`Cleanup: stopped own server PID ${processHandle.pid}.`);
  }
  const report = lines.join('\n\n'); await writeFile(path.join(directory, 'report.txt'), report); console.log(report);
}
