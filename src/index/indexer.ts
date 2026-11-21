import { setImmediate as yieldNow } from 'node:timers/promises';
import type { Config } from '../config.js';
import { PathGuard } from '../paths.js';
import { Extractor } from '../extract/runner.js';
import { imageExtensions, readable } from '../extract/formats.js';
import path from 'node:path';
import { Store } from './store.js';
import { IndexControls } from './controls.js';
import { chunkParts, tokens } from './text.js';
import { EMPTY_FILE, INTERRUPTED, InterruptedError, NOT_FOUND, OCR_DEFERRED, OCR_TIMEOUT, UserError, type Chunk, type DocumentRow, type Extraction, type Logger } from '../types.js';

const isImage = (file: string): boolean => imageExtensions.has(path.extname(file).toLowerCase());
import { Trash } from '../trash.js';

/** Repeats of a file whose processing was cut off, per server run; after them the failure stands. */
const MAX_RETRIES = 2;
const RETRIED_ERRORS = new Set([INTERRUPTED, OCR_TIMEOUT]);
const pageNumber = (label: string): number => Number(/^Страница (\d+)$/u.exec(label)?.[1] ?? 0);

type JobOutcome = 'done' | 'yielded' | 'retry';
interface QueuedJob { file: string; recognize: boolean; urgent: boolean; preempted: boolean; resolve: () => void; reject: (error: unknown) => void }
export interface ReadingProgress { row: DocumentRow | undefined; parts: Pick<Chunk, 'label' | 'text'>[]; recognized: number; waiting: number[] }

export class Indexer {
  scanning = false;
  lastScan: string | null = null;
  scanFailed = false;
  readonly discovered = new Set<string>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly urgentJobs: QueuedJob[] = [];
  private readonly backgroundJobs: QueuedJob[] = [];
  private readonly retries = new Map<string, number>();
  private running: QueuedJob | undefined;
  private runningWork: Promise<void> | undefined;
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
    await this.settle(paths);
    for (const relative of paths) {
      for (const row of this.store.all()) if (row.path === relative || row.path.startsWith(`${relative}/`)) this.store.remove(row.path);
      for (const file of this.discovered) if (file === relative || file.startsWith(`${relative}/`)) this.discovered.delete(file);
      let target;
      try { target = await this.guard.resolve(relative); } catch { continue; }
      if (target.info.isFile()) await this.ensure(relative, { urgent: true });
      else if (target.info.isDirectory()) for await (const file of this.guard.walk(relative)) await this.ensure(file, { urgent: true });
    }
  }

  async relocate(from: string, to: string): Promise<void> {
    await this.settle([from, to]);
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
    if (target.info.isFile()) await this.ensure(to, { urgent: true });
    else for await (const file of this.guard.walk(to)) await this.ensure(file, { urgent: true });
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
    this.scanPromise = this.scan().catch(() => {
      this.scanFailed = true;
      this.logger({ level: 'warn', message: 'Обход документов не завершён; существующий индекс сохранён.' });
    }).finally(() => {
      this.scanning = false;
      this.scanPromise = undefined;
      if (this.rescanAgain) { this.rescanAgain = false; void this.rescan(); }
    });
    return this.scanPromise;
  }

  /**
   * Applies the walk's snapshot after the fact. A path missing from it but still on disk was written while
   * the walk ran: its freshly indexed row stays. Only a path that is really gone leaves the index.
   */
  private async applyPresence(present: Set<string>): Promise<void> {
    for (const row of this.store.all()) {
      if (present.has(row.path)) continue;
      try { await this.guard.resolve(row.path); }
      catch { this.store.remove(row.path); this.discovered.delete(row.path); }
    }
    for (const file of [...this.discovered]) {
      if (present.has(file)) continue;
      try { await this.guard.resolve(file); }
      catch { this.discovered.delete(file); }
    }
    for (const file of present) this.discovered.add(file);
    for (const row of this.store.all()) this.discovered.add(row.path);
  }

  private async scan(): Promise<void> {
    if (!this.config.readOnly) await this.trash.purge();
    const present = new Set<string>();
    for await (const file of this.guard.walk()) {
      if (this.stopped) return;
      present.add(file);
      await yieldNow();
    }
    // The walk runs outside the write lock, so a file written while it was running must keep the row
    // the write already indexed. Only paths that are really gone leave the index.
    await this.exclusive(() => this.applyPresence(present));
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

  /**
   * Index the file if it changed. A full request (the default) also recognizes scans that an earlier text-only pass
   * deferred. An urgent request is someone waiting for this file: it goes ahead of background work.
   */
  async ensure(file: string, options: { recognize?: boolean; urgent?: boolean } = {}): Promise<void> {
    const recognize = options.recognize !== false;
    const urgent = options.urgent === true;
    if (this.stopped) throw new UserError('Сервер останавливается.');
    const resolved = await this.guard.resolve(file, 'file');
    const relative = resolved.relative;
    this.discovered.add(relative);
    const active = this.jobs.get(relative);
    if (active) {
      if (urgent) this.promote(relative);
      // A text-only job in flight does not satisfy a full request: wait for it, then recognize if it deferred scans.
      if (!recognize) return active;
      await active.catch(() => {});
      if (this.store.get(relative)?.error !== OCR_DEFERRED) return active;
      return this.ensure(file, options);
    }
    const row = this.store.get(relative);
    if (row && row.size === resolved.info.size && row.mtime_ms === resolved.info.mtimeMs && !(recognize && row.error === OCR_DEFERRED) && !this.retryable(row)) return;
    const job = this.enqueue(relative, recognize, urgent);
    this.jobs.set(relative, job);
    try { await job; } finally { this.jobs.delete(relative); }
  }

  /**
   * A search found files changed since indexing: a pass picks them up in its usual order, behind the files agents
   * are reading and with recognition where it is due. A pause is respected, as nobody asked for these files.
   * Returns whether a pass will run.
   */
  noticeChanges(): boolean {
    if (this.paused || this.stopped) return false;
    this.requestRescan();
    return true;
  }

  /** What a reader can have before processing ends: the current version's text, with the pages recognized so far. */
  readingProgress(file: string, info: { size: number; mtimeMs: number }): ReadingProgress {
    const row = this.store.get(file);
    const pages = this.store.recognitionPages(file, info.size, info.mtimeMs);
    const recognized = new Map(pages.flatMap((page) => page.text === null ? [] : [[page.page, page.text] as const]));
    const current = row?.size === info.size && row.mtime_ms === info.mtimeMs && row.error === OCR_DEFERRED;
    const chunks = current ? this.store.chunks(file).filter((chunk) => !recognized.has(pageNumber(chunk.label))) : [];
    const parts: Pick<Chunk, 'label' | 'text'>[] = [...chunks, ...[...recognized].map(([page, text]) => ({ label: `Страница ${page}`, text }))];
    parts.sort((left, right) => pageNumber(left.label) - pageNumber(right.label));
    return { row: current ? row : undefined, parts, recognized: recognized.size, waiting: pages.filter((page) => page.text === null).map((page) => page.page) };
  }

  private retryable(row: DocumentRow): boolean {
    return row.status === 'error' && row.error !== null && RETRIED_ERRORS.has(row.error) && (this.retries.get(row.path) ?? 0) < MAX_RETRIES;
  }

  private enqueue(file: string, recognize: boolean, urgent: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const job: QueuedJob = { file, recognize, urgent, preempted: false, resolve, reject };
      (urgent ? this.urgentJobs : this.backgroundJobs).push(job);
      if (urgent) this.yieldRunning(file);
      this.pump();
    });
  }

  private promote(file: string): void {
    if (this.running?.file === file) { this.running.urgent = true; return; }
    const index = this.backgroundJobs.findIndex((job) => job.file === file);
    if (index < 0) return;
    const [job] = this.backgroundJobs.splice(index, 1);
    job!.urgent = true;
    this.urgentJobs.push(job!);
    this.yieldRunning(file);
  }

  /** Recognition of a long scan gives way between pages; what it has done is kept and it resumes later. */
  private yieldRunning(forFile?: string): void {
    const running = this.running;
    if (!running?.recognize || running.file === forFile) return;
    running.preempted = true;
    this.extractor.requestYield();
  }

  private pump(): void {
    if (this.running) return;
    const job = this.urgentJobs.shift() ?? this.backgroundJobs.shift();
    if (!job) return;
    this.running = job;
    job.preempted = false;
    this.runningWork = this.indexFile(job).then((outcome) => {
      if (outcome === 'done') job.resolve();
      else if (job.urgent) this.urgentJobs.push(job);
      else if (outcome === 'yielded') this.backgroundJobs.unshift(job);
      else this.backgroundJobs.push(job);
    }, job.reject).finally(() => {
      this.running = undefined;
      this.runningWork = undefined;
      this.pump();
    });
  }

  /**
   * Lets the work in progress end, soonest possible, before a change to the files is applied.
   * A job for another file is not waited for: a background pass indexes the whole folder, and a write
   * to one document must not queue behind it.
   */
  private async settle(paths?: string[]): Promise<void> {
    const running = this.running;
    if (paths && running && !paths.some((target) => running.file === target || running.file.startsWith(`${target}/`))) return;
    this.yieldRunning();
    await this.runningWork;
  }

  private async save(file: string, before: { size: number; mtimeMs: number; ino: number | bigint }, extracted: Extraction): Promise<void> {
    const after = await this.guard.resolve(file, 'file');
    if (before.size !== after.info.size || before.mtimeMs !== after.info.mtimeMs || before.ino !== after.info.ino) throw new UserError('Файл изменился во время чтения. Повторите запрос.');
    const chunks = chunkParts(extracted.parts);
    const bodies: string[] = [];
    for (const chunk of chunks) { bodies.push(tokens(chunk.text).join(' ')); await yieldNow(); }
    const final = await this.guard.resolve(file, 'file');
    if (after.info.size !== final.info.size || after.info.mtimeMs !== final.info.mtimeMs || after.info.ino !== final.info.ino) throw new UserError('Файл изменился во время чтения. Повторите запрос.');
    this.store.put(file, final.info.size, final.info.mtimeMs, extracted.unsupported ? 'unsupported' : extracted.partial ? 'partial' : 'ok', extracted.reason ?? null, chunks, bodies, extracted.ocrDeferred ? extracted.scanPages : []);
  }

  private noteRetry(file: string): boolean {
    const attempt = (this.retries.get(file) ?? 0) + 1;
    if (attempt > MAX_RETRIES) return false;
    this.retries.set(file, attempt);
    this.logger({ level: 'warn', message: 'Обработка файла прервана, будет повторена.', attempt });
    return true;
  }

  private async indexFile(job: QueuedJob): Promise<JobOutcome> {
    const { file, recognize } = job;
    if (this.stopped) return 'done';
    const before = await this.guard.resolve(file, 'file');
    const { size, mtimeMs } = before.info;
    if (!readable(file)) { this.store.put(file, size, mtimeMs, 'unsupported', 'Неподдерживаемый тип файла.', []); return 'done'; }
    // An empty file has nothing to read; say so instead of reporting it as damaged.
    if (size === 0) { this.store.put(file, 0, mtimeMs, 'unsupported', EMPTY_FILE, []); return 'done'; }
    if (size > this.config.maxFileBytes) { this.store.put(file, size, mtimeMs, 'error', 'Файл слишком большой.', []); return 'done'; }
    try {
      const row = this.store.get(file);
      // A PDF's text layer comes first: it may be all there is, and a reader can have it while the scans are recognized.
      if (recognize && path.extname(file).toLowerCase() === '.pdf' && !(row?.size === size && row.mtime_ms === mtimeMs && row.error === OCR_DEFERRED)) {
        const text = await this.extractor.extract(file, { recognize: false });
        await this.save(file, before.info, text);
        if (!text.ocrDeferred) { this.retries.delete(file); return 'done'; }
        if (job.preempted) return 'yielded';
      }
      const known = new Map(this.store.recognitionPages(file, size, mtimeMs).flatMap((page) => page.text === null ? [] : [[page.page, page.text] as const]));
      const extracted = await this.extractor.extract(file, {
        recognize, known, yielding: () => job.preempted,
        onPage: (page, text) => { if (text !== undefined) this.store.saveRecognizedPage(file, size, mtimeMs, page, text); },
      });
      if (extracted.yielded) return 'yielded';
      // Pages that ran out of time get another run; if they never succeed, the rest of the document still stands.
      if (extracted.retryPages && this.noteRetry(file)) return 'retry';
      await this.save(file, before.info, extracted);
      this.retries.delete(file);
    } catch (error) {
      if (this.stopped) return 'done';
      try { await this.guard.resolve(file, 'file'); } catch { this.store.remove(file); throw new UserError(NOT_FOUND); }
      if (error instanceof InterruptedError && this.noteRetry(file)) return 'retry';
      this.store.put(file, size, mtimeMs, 'error', error instanceof UserError ? error.message : 'Не удалось обработать файл.', []);
    }
    await yieldNow();
    return 'done';
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
    await Promise.allSettled(this.jobs.values());
  }
}
