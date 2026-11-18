import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createMcpServer } from './mcp.js';
import type { Tools } from './tools.js';
import { MAX_TEXT, type Logger } from './types.js';
import { BROWSE_MESSAGES, BrowseError, Browser, browseQuery, type BrowseCode } from './browse.js';
import { PathGuard } from './paths.js';
import { Control, controlSwitch, parseFailuresQuery } from './control.js';

export const BODY_LIMIT = MAX_TEXT * 6 + 100_000;
function rpcError(response: ServerResponse, status: number, message: string, code = -32600): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}

function browseError(response: ServerResponse, status: number, code: BrowseCode, message: string = BROWSE_MESSAGES[code]): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message, code }));
}

export const BROWSE_FILE_CONCURRENCY = 4;
const BROWSE_ROUTES = new Set(['/browse/files', '/browse/file']);
const CONTROL_ROUTES = new Map([['/control/status', 'GET'], ['/control/failures', 'GET'], ['/control/indexing', 'POST'], ['/control/recognition', 'POST'], ['/control/rescan', 'POST']]);
const CONTROL_BODY_LIMIT = 4096;

export function authorized(header: string | undefined, token: string): boolean {
  const expected = createHash('sha256').update(token).digest();
  const match = /^Bearer ([\x21-\x7e]+)$/u.exec(header ?? '');
  const supplied = createHash('sha256').update(match?.[1] ?? '').digest();
  return timingSafeEqual(expected, supplied) && match !== null;
}

async function body(request: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      if (error) { chunks.length = 0; request.resume(); reject(error); }
      else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch (failure) { reject(failure); }
      }
    };
    const data = (bytes: Buffer) => {
      length += bytes.length;
      if (length > limit) finish(new RangeError('body limit'));
      else chunks.push(bytes);
    };
    const end = () => finish();
    const aborted = () => finish(new Error('request aborted'));
    const timer = setTimeout(() => finish(new Error('request timeout')), 15_000);
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', () => finish(new Error('request error')));
  });
}

export function createHttpServer(config: Config, tools: Tools, logger: Logger, browser = new Browser(new PathGuard(config.docsRoot, config.ignore), config), control?: Control) {
  let active = 0;
  let reading = 0;
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    const start = performance.now();
    response.once('finish', () => logger({ method: request.method, status: response.statusCode, duration_ms: Math.round(performance.now() - start) }));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const route = (request.url ?? '').split('?')[0];
    if (route === '/healthz' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('ok'); return; }
    if (BROWSE_ROUTES.has(route!)) {
      const browseRoute = route as '/browse/files' | '/browse/file';
      if (!authorized(request.headers.authorization, config.token)) { response.setHeader('WWW-Authenticate', 'Bearer'); browseError(response, 401, 'invalid_request', 'Требуется действительный токен доступа.'); request.resume(); return; }
      if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); browseError(response, 405, 'invalid_request', 'Метод не поддерживается. Используйте GET.'); request.resume(); return; }
      if (request.headers.origin !== undefined) { browseError(response, 403, 'invalid_request', 'Запросы из браузера не разрешены.'); request.resume(); return; }
      if (active >= 64 || browseRoute === '/browse/file' && reading >= BROWSE_FILE_CONCURRENCY) { response.setHeader('Retry-After', '1'); browseError(response, 429, 'unavailable', 'Слишком много запросов. Повторите позже.'); request.resume(); return; }
      let query: ReturnType<typeof browseQuery>;
      try { query = browseQuery(request.url ?? '', browseRoute); }
      catch { browseError(response, 400, 'invalid_request'); request.resume(); return; }
      request.resume();
      active++;
      if (browseRoute === '/browse/file') reading++;
      let released = false;
      const release = () => { if (!released) { released = true; active--; if (browseRoute === '/browse/file') reading--; } };
      response.once('close', release);
      void (async () => {
        try {
          if (browseRoute === '/browse/files') {
            const listing = await browser.list(query.path, query.offset);
            if (response.destroyed) return;
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify(listing));
          } else {
            const bytes = await browser.read(query.path, query.version);
            if (response.destroyed) return;
            response.writeHead(200, {
              'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox",
            });
            response.end(bytes);
          }
        } catch (error) {
          if (response.headersSent || response.destroyed) { if (!response.writableEnded) response.destroy(); return; }
          if (error instanceof BrowseError) browseError(response, error.status, error.code, error.message);
          else browseError(response, 503, 'unavailable');
        } finally { if (response.writableEnded || response.destroyed) release(); }
      })();
      return;
    }
    const controlMethod = control && CONTROL_ROUTES.get(route!);
    if (control && controlMethod) {
      if (!authorized(request.headers.authorization, config.token)) { response.setHeader('WWW-Authenticate', 'Bearer'); browseError(response, 401, 'invalid_request', 'Требуется действительный токен доступа.'); request.resume(); return; }
      if (request.method !== controlMethod) { response.setHeader('Allow', controlMethod); browseError(response, 405, 'invalid_request', `Метод не поддерживается. Используйте ${controlMethod}.`); request.resume(); return; }
      if (request.headers.origin !== undefined) { browseError(response, 403, 'invalid_request', 'Запросы из браузера не разрешены.'); request.resume(); return; }
      if (Number(request.headers['content-length'] ?? 0) > CONTROL_BODY_LIMIT) { browseError(response, 413, 'invalid_request'); request.resume(); return; }
      if (active >= 64) { response.setHeader('Retry-After', '1'); browseError(response, 429, 'unavailable', 'Слишком много запросов. Повторите позже.'); request.resume(); return; }
      active++;
      let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      response.once('close', release);
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
      void (async () => {
        try {
          if (route === '/control/status') { request.resume(); send(200, await control.status()); }
          else if (route === '/control/failures') { request.resume(); const { offset, limit } = parseFailuresQuery(request.url ?? ''); send(200, await control.failures(offset, limit)); }
          else if (route === '/control/rescan') { request.resume(); control.rescan(); send(202, { accepted: true }); }
          else {
            const { paused } = controlSwitch.parse(await body(request, CONTROL_BODY_LIMIT));
            send(200, await (route === '/control/indexing' ? control.setIndexingPaused(paused) : control.setRecognitionPaused(paused)));
          }
        } catch (error) {
          if (response.headersSent || response.destroyed) { if (!response.writableEnded) response.destroy(); return; }
          if (error instanceof RangeError) browseError(response, 413, 'invalid_request');
          else if (error instanceof SyntaxError || error instanceof ZodError) browseError(response, 400, 'invalid_request');
          else browseError(response, 503, 'unavailable');
        } finally { if (response.writableEnded || response.destroyed) release(); }
      })();
      return;
    }
    if (route !== '/mcp') { rpcError(response, 404, 'Не найдено.'); return; }
    if (!authorized(request.headers.authorization, config.token)) { response.setHeader('WWW-Authenticate', 'Bearer'); rpcError(response, 401, 'Требуется действительный токен доступа.', -32001); return; }
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); rpcError(response, 405, 'Метод не поддерживается. Используйте POST.'); return; }
    if (request.headers.origin) { rpcError(response, 403, 'Запросы из браузера не разрешены.'); return; }
    if (Number(request.headers['content-length'] ?? 0) > BODY_LIMIT) { rpcError(response, 413, 'Запрос превышает допустимый размер.'); request.resume(); return; }
    if (active >= 64) { rpcError(response, 429, 'Слишком много запросов. Повторите позже.'); request.resume(); return; }
    active++;
    void (async () => {
      const mcp = createMcpServer(tools, logger);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let cleaned = false;
      const cleanup = () => { if (!cleaned) { cleaned = true; active--; void mcp.close().catch(() => {}); } };
      response.once('close', cleanup);
      try {
        const parsed = await body(request);
        await mcp.connect(transport);
        await transport.handleRequest(request, response, parsed);
      } catch (error) {
        if (!response.headersSent && !response.destroyed) rpcError(response, error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 500, error instanceof RangeError ? 'Запрос превышает допустимый размер.' : error instanceof SyntaxError ? 'Некорректный JSON.' : 'Не удалось обработать запрос.', error instanceof SyntaxError ? -32700 : -32603);
        else if (!response.writableEnded) response.end();
      } finally { if (response.writableEnded || response.destroyed) cleanup(); }
    })();
  });
  server.keepAliveTimeout = 5000;
  return server;
}
