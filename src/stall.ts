import type { Logger } from './types.js';

export interface StallOptions { intervalMs?: number; thresholdMs?: number; indexing?: () => boolean }

/**
 * Logs when the main thread could not run for a while. Requests wait unseen during such a pause: it happens before
 * their handlers start, so the duration logged for each call does not show it.
 */
export function watchStalls(logger: Logger, { intervalMs = 500, thresholdMs = 2000, indexing = () => false }: StallOptions = {}): () => void {
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    const blocked = now - expected;
    expected = now + intervalMs;
    if (blocked >= thresholdMs) logger({ level: 'warn', message: 'Сервер не отвечал: основной поток был занят.', blocked_ms: Math.round(blocked), indexing: indexing() });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
