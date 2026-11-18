import { z } from 'zod';
import type { Indexer } from './index/indexer.js';
import { VERSION } from './version.js';

export const controlSwitch = z.object({ paused: z.boolean() }).strict();

/** Indexing management for the connected client. Deliberately not an MCP tool: agents cannot reach it. */
export class Control {
  constructor(private readonly indexer: Indexer) {}

  async status() {
    const { failures, failureTotal, scanning, ...counts } = await this.indexer.progress();
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

  setIndexingPaused(paused: boolean) { this.indexer.setPaused(paused); return this.status(); }
  setRecognitionPaused(paused: boolean) { this.indexer.setRecognitionPaused(paused); return this.status(); }
  rescan(): void { this.indexer.requestRescan(); }
}
