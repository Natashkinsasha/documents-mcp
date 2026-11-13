import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { claimCue, cueClaimUrl, normalizeCueAddress, normalizeCueCode } from '../src/cue.js';
import { waitForHealth } from '../src/install.js';

const code = 'ABCD-EFGH-JKMN';
const tunnelToken = 'private-tunnel-token';
const connection = { tunnelToken, publicUrl: 'https://vs.cuechat.org', port: 4317 };

async function localServer(context: TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('Cue address normalization accepts cabinet addresses, HTTPS and MCP URLs', () => {
  for (const value of ['vs.cuechat.org', ' https://VS.cuechat.org/ ', 'vs.cuechat.org/mcp', 'https://vs.cuechat.org/mcp/']) assert.equal(normalizeCueAddress(value), 'vs.cuechat.org');
  for (const value of ['', 'localhost', 'http://vs.cuechat.org', 'https://user:pass@vs.cuechat.org', 'vs.cuechat.org:3000', 'vs.cuechat.org/other', 'vs.cuechat.org?a=1', 'vs.cuechat.org?', 'vs.cuechat.org#', 'vs.cuechat.org/#x', '-vs.cuechat.org', 'vs..cuechat.org', '127.0.0.1', 'vs.cuechat.org\\mcp', 'vs. cuechat.org', `${'a'.repeat(64)}.org`]) assert.throws(() => normalizeCueAddress(value), undefined, value);
});

test('Cue codes use exactly three Crockford base32 groups', () => {
  assert.equal(normalizeCueCode(' abcd-efgh-jkmn '), code);
  assert.equal(normalizeCueCode('0123-4567-89TV'), '0123-4567-89TV');
  for (const value of ['', 'ABCD-EFGH', 'ABCDEFGHIJKM', 'ABCD-EFGH-JKMI', 'ABCD-EFGH-JKML', 'ABCD-EFGH-JKMO', 'ABCD-EFGH-JKMU', 'ABCD EFGH JKMN']) assert.throws(() => normalizeCueCode(value));
});

test('CUE_URL is HTTPS-only except exact local test hosts, and only builds the claim URL', () => {
  assert.equal(cueClaimUrl('https://app.cuechat.org'), 'https://app.cuechat.org/api/document-servers/claim');
  for (const host of ['localhost', '127.0.0.1']) assert.equal(cueClaimUrl(`http://${host}:4321/`), `http://${host}:4321/api/document-servers/claim`);
  for (const value of ['http://app.cuechat.org', 'http://localhost.evil.test', 'http://127.0.0.2', 'file:///tmp', 'https://user:password@app.cuechat.org', 'https://app.cuechat.org/path', 'https://app.cuechat.org?query=1']) assert.throws(() => cueClaimUrl(value));
});

test('claim sends normalized host/code and Russian headers and returns tunnel settings without output', async (context) => {
  const output: string[] = [];
  const baseUrl = await localServer(context, async (request, response) => {
    assert.equal(request.url, '/api/document-servers/claim'); assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json'); assert.equal(request.headers['accept-language'], 'ru');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { host: 'vs.cuechat.org', code });
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(connection));
  });
  assert.deepEqual(await claimCue('https://VS.cuechat.org/mcp', code.toLowerCase(), { baseUrl, progress: (line) => output.push(line) }), connection);
  assert.deepEqual(output, []);
});

for (const status of [400, 404, 410, 429, 502, 503]) {
  test(`claim preserves localized ${status} error, redacts secrets and does not retry other statuses`, async (context) => {
    let attempts = 0;
    const output: string[] = [];
    const baseUrl = await localServer(context, (_request, response) => {
      attempts++;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      response.end(JSON.stringify({ error: `Сервер недоступен: ${code} ${tunnelToken}`, tunnelToken }));
    });
    await assert.rejects(claimCue('vs.cuechat.org', code, { baseUrl, retryWindowMs: 1000, retryMs: 2000, progress: (line) => output.push(line) }), (error: Error) => {
      assert.match(error.message, /Сервер недоступен/u); assert.ok(!error.message.includes(code)); assert.ok(!error.message.includes(tunnelToken));
      if (status === 429) assert.match(error.message, /60 с/u);
      output.push(error.message); return true;
    });
    assert.equal(attempts, 1);
    assert.ok(!output.join('\n').includes(code)); assert.ok(!output.join('\n').includes(tunnelToken));
  });
}

test('claim retries 503 then succeeds with the same request and safe progress', async (context) => {
  let attempts = 0;
  const output: string[] = [];
  const baseUrl = await localServer(context, (_request, response) => {
    attempts++; response.writeHead(attempts < 3 ? 503 : 200, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    response.end(JSON.stringify(attempts < 3 ? { error: 'Адрес ещё создаётся' } : connection));
  });
  assert.deepEqual(await claimCue('vs.cuechat.org', code, { baseUrl, retryMs: 10, retryWindowMs: 2000, progress: (line) => output.push(line) }), connection);
  assert.equal(attempts, 3); assert.equal(output.length, 2);
  assert.ok(!output.join('').includes(code)); assert.ok(!output.join('').includes(tunnelToken));
});

test('claim times out a stalled response without leaking request or token', async (context) => {
  const baseUrl = await localServer(context, () => {});
  await assert.rejects(claimCue('vs.cuechat.org', code, { baseUrl, timeoutMs: 30 }), /Не удалось получить ответ Cue/u);
});

test('persistent 503 retries stop at the retry-window deadline with the localized error', async (context) => {
  let attempts = 0;
  const baseUrl = await localServer(context, (_request, response) => { attempts++; response.writeHead(503); response.end(JSON.stringify({ error: 'Адрес ещё готовится' })); });
  await assert.rejects(claimCue('vs.cuechat.org', code, { baseUrl, retryMs: 10, retryWindowMs: 100 }), /Адрес ещё готовится/u);
  assert.ok(attempts > 1); assert.ok(attempts <= 10);
});

test('claim rejects redirects, invalid JSON and invalid returned tunnel settings', async (context) => {
  for (const payload of [{ ...connection, port: 0 }, { ...connection, port: '3000' }, { ...connection, tunnelToken: 'secret\nvalue' }, { ...connection, publicUrl: 'https://other.cuechat.org' }, null]) {
    const baseUrl = await localServer(context, (_request, response) => response.end(JSON.stringify(payload)));
    await assert.rejects(claimCue('vs.cuechat.org', code, { baseUrl }));
  }
  const baseUrl = await localServer(context, (_request, response) => { response.writeHead(302, { Location: '/other' }); response.end(); });
  await assert.rejects(claimCue('vs.cuechat.org', code, { baseUrl }));
});

test('health requires ok, not just an HTTP success', async (context) => {
  const baseUrl = await localServer(context, (request, response) => response.end(request.url === '/healthz' ? 'ok' : 'not healthy'));
  assert.equal(await waitForHealth(`${baseUrl}/healthz`, 200), true);
  assert.equal(await waitForHealth(`${baseUrl}/wrong`, 30), false);
});
