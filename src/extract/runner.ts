import { Worker } from 'node:worker_threads';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard } from '../paths.js';
import { UserError, type Extraction } from '../types.js';

export class Extractor {
  private stopping = false;
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Extraction) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly guard: PathGuard, private readonly runtime: string, private readonly langs: string[], private readonly maxBytes: number, private readonly maxPages: number) {}

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(this.runtime, 'extract-worker.cjs'), {
      execArgv: [], env: {}, workerData: { runtime: this.runtime, langs: this.langs, ocrMaxPages: this.maxPages },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 },
    });
    this.worker = worker;
    worker.on('message', (message: { id: number; result?: Extraction; error?: string }) => {
      const job = this.pending.get(message.id);
      if (!job) return;
      clearTimeout(job.timer); this.pending.delete(message.id);
      if (message.result) job.resolve(message.result);
      else job.reject(new UserError(message.error ?? 'Не удалось прочитать документ.'));
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new UserError('Обработка документа прервана: ошибка обработчика или предел ресурсов.')); }
      this.pending.clear();
    };
    worker.once('error', failed); worker.once('exit', failed);
    return worker;
  }

  async extract(relative: string): Promise<Extraction> {
    if (this.stopping) throw new UserError('Сервер останавливается.');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'documents-mcp-'));
    try {
      const source = await this.guard.openFile(relative);
      const snapshot = path.join(directory, `input${path.extname(relative).toLowerCase()}`);
      const destination = await open(snapshot, 'wx', 0o600).catch(async (error: unknown) => { await source.handle.close(); throw error; });
      try {
        if (source.info.size > this.maxBytes) throw new UserError('Файл слишком большой.');
        const buffer = Buffer.alloc(64 * 1024);
        let copied = 0;
        while (true) {
          const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          copied += bytesRead;
          if (copied > this.maxBytes) throw new UserError('Файл слишком большой.');
          await destination.writeFile(buffer.subarray(0, bytesRead));
        }
        const after = await source.handle.stat();
        if (after.size !== source.info.size || after.mtimeMs !== source.info.mtimeMs) throw new UserError('Файл изменился во время чтения. Повторите запрос.');
        await this.guard.resolve(relative, 'file');
      } finally { await source.handle.close(); await destination.close(); }
      if (this.stopping) throw new UserError('Сервер останавливается.');
      return await new Promise<Extraction>((resolve, reject) => {
        const worker = this.getWorker();
        const id = ++this.sequence;
        const timer = setTimeout(() => { void worker.terminate(); }, 10 * 60_000);
        this.pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, file: snapshot });
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async close(): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { void worker.terminate(); }, 2000);
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
      worker.postMessage({ stop: true });
    });
  }
}
