import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { Logger } from '../types.js';

const saved = z.object({ paused: z.boolean(), recognitionPaused: z.boolean() }).strict();
export type IndexControlState = z.infer<typeof saved>;

/** Indexing switches. They live beside the index database, so rebuilding the index keeps them. */
export class IndexControls {
  private state: IndexControlState = { paused: false, recognitionPaused: false };

  constructor(private readonly file: string, logger: Logger) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger({ level: 'warn', message: 'Настройки индексации не прочитаны; используются значения по умолчанию.' });
      return;
    }
    try { this.state = saved.parse(JSON.parse(text)); }
    catch { logger({ level: 'warn', message: 'Настройки индексации повреждены; используются значения по умолчанию.' }); }
  }

  get paused(): boolean { return this.state.paused; }
  get recognitionPaused(): boolean { return this.state.recognitionPaused; }

  /** The new value applies only after it is safely on disk. */
  update(change: Partial<IndexControlState>): void {
    const next = { ...this.state, ...change };
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    this.state = next;
  }
}
