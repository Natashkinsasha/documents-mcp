import { setImmediate as yieldNow } from 'node:timers/promises';
import type { Config } from '../config.js';
import { PathGuard } from '../paths.js';
import { Extractor } from '../extract/runner.js';
import { imageExtensions, readable } from '../extract/formats.js';
import path from 'node:path';
import { Store } from './store.js';
import { IndexControls } from './controls.js';
import { chunkParts, tokens } from './text.js';
import { EMPTY_FILE, NOT_FOUND, OCR_DEFERRED, UserError, type DocumentRow, type Logger } from '../types.js';

const isImage = (file: string): boolean => imageExtensions.has(path.extname(file).toLowerCase());
import { Trash } from '../trash.js';

export class Indexer {
  scanning = false;
  lastScan: string | null = null;
  scanFailed = false;
  readonly discovered = new Set<string>();
  private readonly jobs = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private scanPromise: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private changes: Promise<unknown> = Promise.resolve();
  private rescanAgain = false;
  private readonly controls: IndexControls;

  constructor(readonly config: Config, readonly guard: PathGuard, readonly store: Store, private readonly extractor: Extractor, private readonly logger: Logger, readonly trash = new Trash(guard)) {
    this.controls = new IndexControls(path.join(config.indexDir, 'indexing-controls.json'), logger);
  }

  get paused(): boolean { return this.controls.paused; }
  get recognitionPaused(): boolean { return this.controls.recognitionPaused; }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.controls.update({ paused });
    if (!paused) this.requestRescan();
  }

  setRecognitionPaused(recognitionPaused: boolean): void {
    if (recognitionPaused === this.recognitionPaused) return;
    this.controls.update({ recognitionPaused });
    if (!recognitionPaused) this.requestRescan();
  }

  /** A request during a pass runs one more pass afterwards, so changes seen too late are not lost. */
  requestRescan(): void {
    if (this.scanPromise) this.rescanAgain = true;
    else void this.rescan();
  }

  exclusive<Result>(action: () => Promise<Result>): Promise<Result> {
    const operation = this.changes.then(action);
    this.changes = operation.catch(() => {});
    return operation;
  }

  async refresh(paths: string[]): Promise<void> {
    await this.tail;
    for (const relative of paths) {
      for (const row of this.store.all()) if (row.path === relative || row.path.startsWith(`${relative}/`)) this.store.remove(row.path);
      for (const file of this.discovered) if (file === relative || file.startsWith(`${relative}/`)) this.discovered.delete(file);
      let target;
      try { target = await this.guard.resolve(relative); } catch { continue; }
      if (target.info.isFile()) await this.ensure(relative);
      else if (target.info.isDirectory()) for await (const file of this.guard.walk(relative)) await this.ensure(file);
    }
  }

  async relocate(from: string, to: string): Promise<void> {
    await this.tail;
    const documents = this.store.all().filter((row) => row.path === from || row.path.startsWith(`${from}/`)).map((row) => ({ row, chunks: this.store.chunks(row.path) }));
    for (const relative of [from, to]) {
      for (const row of this.store.all()) if (row.path === relative || row.path.startsWith(`${relative}/`)) this.store.remove(row.path);
      for (const file of this.discovered) if (file === relative || file.startsWith(`${relative}/`)) this.discovered.delete(file);
    }
    for (const { row, chunks } of documents) {
      const destination = to + row.path.slice(from.length);
      const current = await this.guard.resolve(destination, 'file');
      this.discovered.add(destination);
      if (current.info.size === row.size && current.info.mtimeMs === row.mtime_ms) this.store.put(destination, row.size, row.mtime_ms, row.status, row.error, chunks);
    }
    const target = await this.guard.resolve(to);
    if (target.info.isFile()) await this.ensure(to);
    else for await (const file of this.guard.walk(to)) await this.ensure(file);
  }

  start(): void {
    void this.rescan();
    this.timer = setInterval(() => { void this.rescan(); }, this.config.rescanMinutes * 60_000);
    this.timer.unref();
  }

  rescan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    if (this.stopped) return Promise.resolve();
    this.scanning = true;
    this.scanFailed = false;
    this.scanPromise = this.exclusive(() => this.scan()).catch(() => {
      this.scanFailed = true;
      this.logger({ level: 'warn', message: 'Обход документов не завершён; существующий индекс сохранён.' });
    }).finally(() => {
      this.scanning = false;
      this.scanPromise = undefined;
      if (this.rescanAgain) { this.rescanAgain = false; void this.rescan(); }
    });
    return this.scanPromise;
  }

  private async scan(): Promise<void> {
    if (!this.config.readOnly) await this.trash.purge();
    const present = new Set<string>();
    for await (const file of this.guard.walk()) {
      if (this.stopped) return;
      present.add(file);
      await yieldNow();
    }
    this.discovered.clear();
    for (const file of present) this.discovered.add(file);
    for (const row of this.store.all()) if (!present.has(row.path)) this.store.remove(row.path);
    // Pauses limit only this background pass: ensure() still serves any file an agent asks for.
    if (this.paused) return;
    // Text first: images and scanned PDF pages need recognition, which is far slower, so they wait for a second pass.
    const recognition: string[] = [];
    for (const file of present) {
      if (this.stopped || this.paused) return;
      if (isImage(file)) { recognition.push(file); continue; }
      try { await this.ensure(file, { recognize: false }); } catch {}
      if (this.store.get(file)?.error === OCR_DEFERRED) recognition.push(file);
      await yieldNow();
    }
    for (const file of recognition) {
      if (this.stopped || this.paused) return;
      if (this.recognitionPaused) break;
      try { await this.ensure(file); } catch {}
      await yieldNow();
    }
    this.lastScan = new Date().toISOString();
    this.logger({ level: 'info', message: 'Обход документов завершён.', files: present.size });
  }

  /** Index the file if it changed. A full request (the default) also recognizes scans that an earlier text-only pass deferred. */
  async ensure(file: string, options: { recognize?: boolean } = {}): Promise<void> {
    const recognize = options.recognize !== false;
    if (this.stopped) throw new UserError('Сервер останавливается.');
    const resolved = await this.guard.resolve(file, 'file');
    const relative = resolved.relative;
    this.discovered.add(relative);
    const active = this.jobs.get(relative);
    if (active) {
      // A text-only job in flight does not satisfy a full request: wait for it, then recognize if it deferred scans.
      if (!recognize) return active;
      await active.catch(() => {});
      if (this.store.get(relative)?.error !== OCR_DEFERRED) return active;
      return this.ensure(file);
    }
    const row = this.store.get(relative);
    if (row && row.size === resolved.info.size && row.mtime_ms === resolved.info.mtimeMs && !(recognize && row.error === OCR_DEFERRED)) return;
    const job = this.tail.then(() => this.indexFile(relative, recognize));
    this.jobs.set(relative, job);
    this.tail = job.catch(() => {});
    try { await job; } finally { this.jobs.delete(relative); }
  }

  private async indexFile(file: string, recognize = true): Promise<void> {
    if (this.stopped) return;
    const before = await this.guard.resolve(file, 'file');
    if (!readable(file)) { this.store.put(file, before.info.size, before.info.mtimeMs, 'unsupported', 'Неподдерживаемый тип файла.', []); return; }
    // An empty file has nothing to read; say so instead of reporting it as damaged.
    if (before.info.size === 0) { this.store.put(file, 0, before.info.mtimeMs, 'unsupported', EMPTY_FILE, []); return; }
    if (before.info.size > this.config.maxFileBytes) { this.store.put(file, before.info.size, before.info.mtimeMs, 'error', 'Файл слишком большой.', []); return; }
    try {
      const extracted = await this.extractor.extract(file, { recognize });
      const after = await this.guard.resolve(file, 'file');
      if (before.info.size !== after.info.size || before.info.mtimeMs !== after.info.mtimeMs || before.info.ino !== after.info.ino) throw new UserError('Файл изменился во время чтения. Повторите запрос.');
      const chunks = chunkParts(extracted.parts);
      const bodies: string[] = [];
      for (const chunk of chunks) { bodies.push(tokens(chunk.text).join(' ')); await yieldNow(); }
      const final = await this.guard.resolve(file, 'file');
      if (after.info.size !== final.info.size || after.info.mtimeMs !== final.info.mtimeMs || after.info.ino !== final.info.ino) throw new UserError('Файл изменился во время чтения. Повторите запрос.');
      this.store.put(file, final.info.size, final.info.mtimeMs, extracted.unsupported ? 'unsupported' : extracted.partial ? 'partial' : 'ok', extracted.reason ?? null, chunks, bodies);
    } catch (error) {
      if (this.stopped) return;
      try { await this.guard.resolve(file, 'file'); } catch { this.store.remove(file); throw new UserError(NOT_FOUND); }
      this.store.put(file, before.info.size, before.info.mtimeMs, 'error', error instanceof UserError ? error.message : 'Не удалось обработать файл.', []);
    }
    await yieldNow();
  }

  /** A search's note about unfinished indexing. Reads memory and the index only: its cost must not grow with the files on disk. */
  searchProgress(): { scanning: boolean; processed: number; total: number } {
    const scanning = this.scanning || this.jobs.size > 0;
    if (!scanning) return { scanning, processed: 0, total: 0 };
    const { documents, processed } = this.store.indexedCounts(OCR_DEFERRED);
    return { scanning, processed, total: Math.max(documents, this.discovered.size) };
  }

  /**
   * Counts from what the index already knows, without touching each file: a client polls this,
   * and checking every file took over a minute on a folder of 120,000. Changed and deleted files
   * are noticed by the next pass, as the search results already are.
   */
  /** One page of failed files. A file gone or hidden since the last pass is left out; the offsets stay those of the index. */
  async failurePage(offset: number, limit: number) {
    const { rows, total } = this.store.failures(offset, limit);
    const failures: typeof rows = [];
    for (const row of rows) {
      try { await this.guard.resolve(row.path, 'file'); failures.push(row); } catch {}
    }
    return { failures, total, nextOffset: rows.length === limit && offset + limit < total ? offset + limit : null };
  }

  async quickProgress() {
    const counts = { total: 0, ready: 0, pending: 0, recognition: 0, partial: 0, failed: 0, unsupported: 0 };
    const rows = this.store.summaries();
    const known = new Set<string>();
    const errors: string[] = [];
    for (const row of rows) {
      known.add(row.path);
      if (this.jobs.has(row.path)) { if (isImage(row.path)) counts.recognition++; else counts.pending++; }
      else if (row.error === OCR_DEFERRED) counts.recognition++;
      else if (row.status === 'ok') counts.ready++;
      else if (row.status === 'partial') counts.partial++;
      else if (row.status === 'error') counts.failed++;
      else counts.unsupported++;
      if (row.status === 'error') errors.push(row.path);
    }
    for (const file of this.discovered) if (!known.has(file)) { if (isImage(file)) counts.recognition++; else counts.pending++; }
    counts.total = rows.length + [...this.discovered].filter((file) => !known.has(file)).length;
    const failures: DocumentRow[] = [];
    for (const file of errors) {
      if (failures.length === 20) break;
      const row = this.store.get(file);
      if (!row) continue;
      try { await this.guard.resolve(file, 'file'); failures.push(row); } catch {}
    }
    return { ...counts, processed: counts.ready + counts.partial + counts.failed + counts.unsupported, failures, failureTotal: errors.length, scanning: this.scanning || this.jobs.size > 0 };
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.extractor.close();
    await this.scanPromise;
    await this.changes;
    await this.tail;
  }
}
