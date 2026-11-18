import { Worker } from 'node:worker_threads';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard } from '../paths.js';
import { INTERRUPTED, InterruptedError, UserError, type Extraction } from '../types.js';

export interface ExtractOptions {
  /** `false` reads text layers only and marks scans and images for a later recognition pass. */
  recognize?: boolean;
  /** Pages already recognized in this file version. */
  known?: ReadonlyMap<number, string>;
  onPage?: (page: number, text?: string) => void;
  /** True when the run should stop at the next page to recognize, even if that was decided before it started. */
  yielding?: () => boolean;
}
interface PendingJob { resolve: (value: Extraction) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; watch: () => void; onPage?: ExtractOptions['onPage'] }

export class Extractor {
  private stopping = false;
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, PendingJob>();
  /** `idleMs` limits the time without any progress, so a long scan may run as long as its pages keep coming. */
  constructor(private readonly guard: PathGuard, private readonly runtime: string, private readonly langs: string[], private readonly maxBytes: number, private readonly maxPages: number, private readonly idleMs = 10 * 60_000) {}

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(this.runtime, 'extract-worker.cjs'), {
      execArgv: [], env: {}, workerData: { runtime: this.runtime, langs: this.langs, ocrMaxPages: this.maxPages },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 },
    });
    this.worker = worker;
    worker.on('message', (message: { id: number; result?: Extraction; error?: string; interrupted?: boolean; page?: number; text?: string }) => {
      const job = this.pending.get(message.id);
      if (!job) return;
      if (message.page !== undefined) { job.watch(); job.onPage?.(message.page, message.text); return; }
      clearTimeout(job.timer); this.pending.delete(message.id);
      if (message.result) job.resolve(message.result);
      else {
        const text = message.error ?? 'Не удалось прочитать документ.';
        job.reject(message.interrupted ? new InterruptedError(text) : new UserError(text));
      }
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new InterruptedError(INTERRUPTED)); }
      this.pending.clear();
    };
    worker.once('error', failed); worker.once('exit', failed);
    return worker;
  }

  /** Asks the running job to stop before its next page to recognize. */
  requestYield(): void {
    for (const id of this.pending.keys()) this.worker?.postMessage({ id, yieldOnly: true });
  }

  async extract(relative: string, options: ExtractOptions = {}): Promise<Extraction> {
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
        const job: PendingJob = {
          resolve, reject, onPage: options.onPage, timer: setTimeout(() => {}, 0),
          watch: () => { clearTimeout(job.timer); job.timer = setTimeout(() => { void worker.terminate(); }, this.idleMs); },
        };
        job.watch();
        this.pending.set(id, job);
        worker.postMessage({ id, file: snapshot, recognize: options.recognize !== false, known: [...(options.known ?? [])], yield: options.yielding?.() === true });
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
