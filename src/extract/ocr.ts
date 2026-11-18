import { createWorker, OEM, type Worker } from 'tesseract.js';
import path from 'node:path';
import { InterruptedError, OCR_TIMEOUT, UserError } from '../types.js';

export class OcrEngine {
  private worker: Promise<Worker> | undefined;
  private stopped = false;
  constructor(private readonly runtime: string, private readonly langs: string[], private readonly timeoutMs = 60_000) {}
  async recognize(image: Uint8Array): Promise<string> {
    if (this.stopped) throw new UserError('Распознавание остановлено.');
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { const worker = this.worker; this.worker = undefined; void worker?.then((worker) => worker.terminate()).catch(() => {}); reject(new InterruptedError(OCR_TIMEOUT)); }, this.timeoutMs); });
    const run = async () => {
      this.worker ??= createWorker(this.langs, OEM.LSTM_ONLY, {
        workerPath: path.join(this.runtime, 'tesseract-worker.cjs'),
        langPath: path.join(this.runtime, 'lang'),
        cacheMethod: 'none', gzip: true, logger: () => {}, errorHandler: () => {},
      });
      return (await (await this.worker).recognize(Buffer.from(image))).data.text.trim();
    };
    try { return await Promise.race([run(), deadline]); }
    finally { clearTimeout(timer); }
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.worker) await this.worker.then((worker) => worker.terminate()).catch(() => {});
    this.worker = undefined;
  }
}
