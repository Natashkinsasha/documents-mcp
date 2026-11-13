import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, serializeConfig } from '../src/config.js';
import { install } from '../src/install.js';

const host = 'vs.cuechat.org';
const code = 'ABCD-EFGH-JKMN';
const tunnelToken = 'fake-cue-smoke-tunnel-token';

async function client(): Promise<void> {
  await mkdir('.cache', { recursive: true });
  const directory = await mkdtemp(path.resolve('.cache/cue-smoke-'));
  try {
    const docs = path.join(directory, 'documents'); await mkdir(docs);
    const paths = { binary: path.join(directory, 'program'), config: path.join(directory, 'config.env'), data: path.join(directory, 'index'), service: path.join(directory, 'service') };
    const settings = await install({ yes: true, docs, cueAddress: `https://${host}/mcp`, cueCode: code, port: '9999' }, {
      platform: 'linux', sea: true, paths, administrator: async () => {},
      deploy: async (configuration) => { await loadConfig(configuration); await writeFile(paths.config, serializeConfig(configuration), { mode: 0o600 }); },
      health: async (url) => { assert.ok(url.includes(':4317/') || url === `https://${host}/healthz`); return true; },
    });
    assert.equal(settings.PORT, '4317'); assert.equal(settings.TUNNEL_TOKEN, tunnelToken);
    const saved = await readFile(paths.config, 'utf8'); assert.ok(!saved.includes(code)); assert.ok(saved.includes(settings.MCP_TOKEN!));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  if (process.argv.includes('--client')) { await client(); return; }
  let claims = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/document-servers/claim');
    assert.equal(request.headers['accept-language'], 'ru');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { host, code }); claims++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ tunnelToken, publicUrl: `https://${host}`, port: 4317 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', import.meta.filename, '--client'], { env: { ...process.env, CUE_URL: endpoint }, timeout: 15_000 });
    assert.equal(claims, 1); assert.match(stdout, /Адрес: https:\/\/vs.cuechat.org/u); assert.match(stdout, /Ключ для Cue: [a-f0-9]{64}/u);
    for (const secret of [code, tunnelToken]) { assert.ok(!stdout.includes(secret)); assert.ok(!stderr.includes(secret)); }
    process.stdout.write(stdout);
    console.log('Проверка локального Cue пройдена: настоящий HTTP claim, конфиг и вывод установщика; установка службы и health подменены, root не нужен.');
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await main();
