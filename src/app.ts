import path from 'node:path';
import { access } from 'node:fs/promises';
import type { Config } from './config.js';
import { PathGuard } from './paths.js';
import { Extractor } from './extract/runner.js';
import { Store } from './index/store.js';
import { Indexer } from './index/indexer.js';
import { Tools } from './tools.js';
import { createHttpServer } from './http.js';
import { log, type Logger } from './types.js';
import { prepareRuntime } from './runtime.js';
import { TunnelSupervisor } from './tunnel.js';
import { Trash } from './trash.js';

export async function createApp(config: Config, options: { logger?: Logger; readWaitMs?: number; now?: () => number } = {}) {
  const logger = options.logger ?? log;
  const runtime = await prepareRuntime(config.indexDir);
  if (config.tunnelToken) await access(path.join(runtime, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')).catch(() => { throw new Error('Встроенный cloudflared отсутствует. При запуске из исходников сначала выполните pnpm build.'); });
  const guard = new PathGuard(config.docsRoot, config.ignore);
  const store = new Store(path.join(config.indexDir, 'index.sqlite'));
  const extractor = new Extractor(guard, runtime, config.ocrLangs, config.maxFileBytes, config.ocrMaxPages);
  const indexer = new Indexer(config, guard, store, extractor, logger, new Trash(guard, options.now));
  const tools = new Tools(indexer, options.readWaitMs, logger);
  const http = createHttpServer(config, tools, logger);
  const tunnel = config.tunnelToken ? new TunnelSupervisor(path.join(runtime, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), config.tunnelToken, logger) : undefined;
  let closed = false;
  return {
    indexer, tools, http, store,
    async start() {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => { http.removeListener('error', reject); resolve(); });
      });
      indexer.start();
      tunnel?.start();
      logger({ level: 'info', message: 'HTTP-сервер запущен.', port: config.port });
    },
    async close() {
      if (closed) return;
      closed = true;
      const stopping = new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections(); });
      await tunnel?.stop();
      await indexer.close();
      await stopping;
      store.close();
    },
  };
}
