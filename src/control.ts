import { z } from 'zod';
import type { Indexer } from './index/indexer.js';
import { VERSION } from './version.js';

export const controlSwitch = z.object({ paused: z.boolean() }).strict();

const failuresQuery = z.object({
  offset: z.string().regex(/^(?:0|[1-9][0-9]{0,8})$/u).default('0').transform(Number),
  limit: z.string().regex(/^[1-9][0-9]?$/u).default('20').transform(Number).pipe(z.number().max(50)),
}).strict();

/** The query of `GET /control/failures`; anything else, a repeated parameter included, is refused as a `ZodError`. */
export function parseFailuresQuery(url: string): z.infer<typeof failuresQuery> {
  const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
  const values = Object.fromEntries(params);
  return failuresQuery.parse([...params.keys()].length === Object.keys(values).length ? values : { repeated: true });
}

/** Indexing management for the connected client. Deliberately not an MCP tool: agents cannot reach it. */
export class Control {
  constructor(private readonly indexer: Indexer) {}

  async status() {
    const { failures, failureTotal, scanning, ...counts } = await this.indexer.quickProgress();
    return {
      version: VERSION,
      paused: this.indexer.paused,
      recognitionPaused: this.indexer.recognitionPaused,
      scanning,
      lastScanAt: this.indexer.lastScan,
      scanFailed: this.indexer.scanFailed,
      counts,
      failures: failures.map((row) => ({ path: row.path, error: row.error ?? 'Ошибка чтения.' })),
      failuresTruncated: failureTotal > failures.length,
    };
  }

  async failures(offset: number, limit: number) {
    const page = await this.indexer.failurePage(offset, limit);
    return { ...page, failures: page.failures.map((row) => ({ path: row.path, error: row.error ?? 'Ошибка чтения.' })) };
  }

  setIndexingPaused(paused: boolean) { this.indexer.setPaused(paused); return this.status(); }
  setRecognitionPaused(paused: boolean) { this.indexer.setRecognitionPaused(paused); return this.status(); }
  rescan(): void { this.indexer.requestRescan(); }
}
