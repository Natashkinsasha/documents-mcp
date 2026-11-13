import { setTimeout as delay } from 'node:timers/promises';

export interface CueConnection { tunnelToken: string; publicUrl: string; port: number }
export interface ClaimOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retryMs?: number;
  retryWindowMs?: number;
  progress?: (message: string) => void;
}

export function normalizeCueAddress(value: string): string {
  const message = 'Адрес из Cue: укажите имя сервера, например vs.cuechat.org, без параметров и порта.';
  const input = value.trim();
  let url: URL;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); } catch { throw new Error(message); }
  if (/[\s\\?#]/u.test(input) || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['/', '/mcp', '/mcp/'].includes(url.pathname)) throw new Error(message);
  const host = url.hostname.toLowerCase();
  if (host.length > 253 || !host.includes('.') || !/[a-z]/u.test(host) || host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) throw new Error(message);
  return host;
}

export function normalizeCueCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u.test(code)) throw new Error('Код из Cue: нужны три группы по четыре символа, например XXXX-XXXX-XXXX. Буквы I, L, O и U не используются.');
  return code;
}

export function cueClaimUrl(value = process.env.CUE_URL ?? 'https://app.cuechat.org'): string {
  const message = 'CUE_URL: нужен HTTPS-адрес; HTTP разрешён только для localhost и 127.0.0.1.';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(message);
  return new URL('/api/document-servers/claim', url).href;
}

export function safeText(value: string, secrets: string[] = []): string {
  let message = value;
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[скрыто]');
  return message.replace(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/giu, '[скрыто]').replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ').slice(0, 2000);
}

export async function claimCue(address: string, installCode: string, options: ClaimOptions = {}): Promise<CueConnection> {
  const host = normalizeCueAddress(address);
  const code = normalizeCueCode(installCode);
  const endpoint = cueClaimUrl(options.baseUrl);
  const end = Date.now() + (options.retryWindowMs ?? 120_000);
  let lastError = 'Cue временно недоступен. Попробуйте позже.';
  do {
    let response: Response;
    let payload: Record<string, unknown>;
    try {
      response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': 'ru' },
        body: JSON.stringify({ host, code }), redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 30_000, end - Date.now()))),
      });
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      payload = body as Record<string, unknown>;
    } catch {
      throw new Error('Не удалось получить ответ Cue за отведённое время. Проверьте подключение и попробуйте снова.');
    }
    if (response.status === 200) {
      if (typeof payload.tunnelToken !== 'string' || !payload.tunnelToken || /[\s\0]/u.test(payload.tunnelToken) || payload.publicUrl !== `https://${host}` || !Number.isInteger(payload.port) || Number(payload.port) < 1 || Number(payload.port) > 65535) throw new Error('Cue вернул некорректные настройки подключения. Попробуйте снова.');
      return { tunnelToken: payload.tunnelToken, publicUrl: payload.publicUrl, port: Number(payload.port) };
    }
    lastError = safeText(typeof payload.error === 'string' ? payload.error : 'Cue не смог подключить сервер. Попробуйте позже.', [code, installCode, typeof payload.tunnelToken === 'string' ? payload.tunnelToken : '']);
    if (response.status !== 503) {
      const retry = response.headers.get('retry-after');
      if (response.status === 429 && retry && /^\d{1,6}$/u.test(retry)) lastError += ` Повторите через ${retry} с.`;
      throw new Error(lastError);
    }
    const retryMs = options.retryMs ?? 10_000;
    if (Date.now() + retryMs >= end) break;
    options.progress?.('Адрес Cue ещё готовится или временно недоступен. Ожидаем подключение…');
    await delay(retryMs);
  } while (Date.now() < end);
  throw new Error(lastError);
}
