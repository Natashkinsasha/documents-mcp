import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { INTERRUPTED, OCR_DEFERRED, OCR_TIMEOUT, type Chunk, type DocumentRow, type Status } from '../types.js';
import { buildQuery, renderChunks, renderedChunks, tokens, type QueryMode } from './text.js';

/** A scanned page of one file version; `text` is null until it is recognized. */
export interface RecognitionPage { page: number; text: string | null }
/** `start` is where the chunk's text begins in the document's rendered text, as read_document counts offsets. */
export interface Hit { path: string; seq: number; start: number; label: string; text: string; mtime_ms: number; indexed_at: string; rank: number }

export class Store {
  private readonly db: DatabaseSync;
  private lastStamp = 0;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS documents (
        path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok','partial','error','unsupported')),
        error TEXT, chars INTEGER NOT NULL, indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE,
        seq INTEGER NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, start INTEGER NOT NULL DEFAULT 0, UNIQUE(path, seq)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(name_tokens, body_tokens, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS recognition_pages (
        path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, page INTEGER NOT NULL, text TEXT,
        PRIMARY KEY (path, page)
      ) WITHOUT ROWID;
    `);
    this.addChunkStarts();
  }

  /** An index made before chunks kept their start gets it once, from the text it already holds. */
  private addChunkStarts(): void {
    const columns = this.db.prepare('PRAGMA table_info(chunks)').all() as unknown as { name: string }[];
    if (columns.some((column) => column.name === 'start')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE chunks ADD COLUMN start INTEGER NOT NULL DEFAULT 0');
      const update = this.db.prepare('UPDATE chunks SET start = ? WHERE id = ?');
      const paths = this.db.prepare('SELECT DISTINCT path FROM chunks').all() as unknown as { path: string }[];
      const chunks = this.db.prepare('SELECT id, label, text FROM chunks WHERE path = ? ORDER BY seq');
      for (const { path } of paths) {
        for (const { chunk, start } of renderedChunks(chunks.all(path) as unknown as { id: number; label: string; text: string }[])) update.run(start, chunk.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** A version stamp for each write: later than any before it, so equal stamps mean the same index version. */
  private stamp(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }

  get(path: string): DocumentRow | undefined { return this.db.prepare('SELECT * FROM documents WHERE path = ?').get(path) as unknown as DocumentRow | undefined; }
  /** Only what a status needs: on a large index this is far lighter than all(). */
  summaries(): Pick<DocumentRow, 'path' | 'status' | 'error'>[] { return this.db.prepare('SELECT path, status, error FROM documents ORDER BY path').all() as unknown as Pick<DocumentRow, 'path' | 'status' | 'error'>[]; }
  /** One page of the files that could not be read, in path order, and how many there are in all. */
  failures(offset: number, limit: number): { rows: Pick<DocumentRow, 'path' | 'error'>[]; total: number } {
    const rows = this.db.prepare("SELECT path, error FROM documents WHERE status = 'error' ORDER BY path LIMIT ? OFFSET ?").all(limit, offset) as unknown as Pick<DocumentRow, 'path' | 'error'>[];
    const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM documents WHERE status = 'error'").get() as unknown as { total: number };
    return { rows, total };
  }
  all(): DocumentRow[] { return this.db.prepare('SELECT * FROM documents ORDER BY path').all() as unknown as DocumentRow[]; }
  /** Documents in the index, and those among them with nothing left to do (`waiting` marks the rest). */
  indexedCounts(waiting: string): { documents: number; processed: number } {
    return this.db.prepare('SELECT COUNT(*) AS documents, COALESCE(SUM(error IS NOT ?), 0) AS processed FROM documents').get(waiting) as unknown as { documents: number; processed: number };
  }
  chunks(path: string): Chunk[] { return this.db.prepare('SELECT seq, label, text FROM chunks WHERE path = ? ORDER BY seq').all(path) as unknown as Chunk[]; }

  recognitionPages(path: string, size: number, mtime: number): RecognitionPage[] {
    return this.db.prepare('SELECT page, text FROM recognition_pages WHERE path = ? AND size = ? AND mtime_ms = ? ORDER BY page').all(path, size, mtime) as unknown as RecognitionPage[];
  }

  /** Keeps one recognized page, so an interrupted run of a long scan resumes after it. */
  saveRecognizedPage(path: string, size: number, mtime: number, page: number, text: string): void {
    this.db.prepare(`INSERT INTO recognition_pages (path, size, mtime_ms, page, text) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (path, page) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, text = excluded.text`).run(path, size, mtime, page, text);
  }

  /** `scanPages` lists the pages still to recognize of a document left waiting for recognition. */
  put(path: string, size: number, mtime: number, status: Status, error: string | null, chunks: Chunk[], bodies?: string[], scanPages: number[] = []): void {
    const prepared = [...renderedChunks(chunks)].map(({ chunk, start }, index) => ({ ...chunk, start, body: bodies?.[index] ?? tokens(chunk.text).join(' ') }));
    const name = tokens(path).join(' ');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.removeInside(path);
      this.db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)').run(path, size, mtime, status, error, renderChunks(chunks).length, this.stamp());
      const insert = this.db.prepare('INSERT INTO chunks (path, seq, label, text, start) VALUES (?, ?, ?, ?, ?)');
      const fts = this.db.prepare('INSERT INTO chunk_fts (rowid, name_tokens, body_tokens) VALUES (?, ?, ?)');
      for (const chunk of prepared) {
        const result = insert.run(path, chunk.seq, chunk.label, chunk.text, chunk.start);
        fts.run(result.lastInsertRowid, name, chunk.body);
      }
      if (!prepared.length && (status === 'ok' || status === 'partial')) {
        const result = insert.run(path, 0, '', '', 0);
        fts.run(result.lastInsertRowid, name, '');
      }
      // Unfinished work keeps its pages: a later run, even after a restart, continues from them.
      if (error === OCR_DEFERRED || error === INTERRUPTED || error === OCR_TIMEOUT) {
        this.db.prepare('DELETE FROM recognition_pages WHERE path = ? AND (size <> ? OR mtime_ms <> ?)').run(path, size, mtime);
        const page = this.db.prepare('INSERT OR IGNORE INTO recognition_pages (path, size, mtime_ms, page) VALUES (?, ?, ?, ?)');
        for (const number of scanPages) page.run(path, size, mtime, number);
      } else this.db.prepare('DELETE FROM recognition_pages WHERE path = ?').run(path);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private removeInside(path: string): void {
    this.db.prepare('DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)').run(path);
    this.db.prepare('DELETE FROM documents WHERE path = ?').run(path);
  }

  remove(path: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.removeInside(path);
      this.db.prepare('DELETE FROM recognition_pages WHERE path = ?').run(path);
      this.db.exec('COMMIT');
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  *search(query: string, folder: string, mode: QueryMode): Generator<Hit> {
    const match = buildQuery(query, mode);
    if (!match) return;
    const prefix = folder ? `${folder}/` : '';
    const statement = this.db.prepare(`
      SELECT chunks.path, chunks.seq, chunks.start, chunks.label, chunks.text, documents.mtime_ms, documents.indexed_at,
             bm25(chunk_fts, 8.0, 1.0) AS rank
      FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.rowid
      JOIN documents ON documents.path = chunks.path
      WHERE chunk_fts MATCH ? AND documents.status IN ('ok', 'partial')
        AND (? = '' OR substr(chunks.path, 1, length(?)) = ?)
      ORDER BY rank, chunks.path, chunks.seq
    `);
    for (const row of statement.iterate(match, prefix, prefix, prefix)) yield row as unknown as Hit;
  }

  close(): void { this.db.close(); }
}
