import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { watchStalls } from '../src/stall.js';

const block = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end); };

test('a blocked main thread is logged once with its length, and a free one is not', async (context) => {
  const entries: Record<string, unknown>[] = [];
  const stop = watchStalls((entry) => entries.push(entry), { intervalMs: 10, thresholdMs: 100, indexing: () => true });
  context.after(stop);
  await sleep(40);
  assert.deepEqual(entries, []);
  block(150);
  await sleep(40);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.level, 'warn');
  assert.equal(entries[0]!.indexing, true);
  assert.ok(Number(entries[0]!.blocked_ms) >= 100);
  stop();
  block(150);
  await sleep(40);
  assert.equal(entries.length, 1);
});
