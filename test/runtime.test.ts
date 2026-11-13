import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractAssets, sha256 } from '../src/runtime.js';
import { tempProject } from './helpers.js';

test('assets are private, verified, reused, repaired and old versions removed', async (context) => {
  const fixture = await tempProject('assets'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const bytes = Buffer.from('embedded worker'); const manifest = { files: { 'worker.cjs': { sha256: sha256(bytes), executable: true } } };
  let reads = 0; const read = async () => { reads++; return bytes; };
  const directory = await extractAssets(fixture.config.indexDir, manifest, read);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, 'worker.cjs'))).mode & 0o777, 0o700);
  await extractAssets(fixture.config.indexDir, manifest, read); assert.equal(reads, 1);
  await writeFile(path.join(directory, 'worker.cjs'), 'corrupt');
  await extractAssets(fixture.config.indexDir, manifest, read); assert.equal(reads, 2);
  assert.equal(await readFile(path.join(directory, 'worker.cjs'), 'utf8'), 'embedded worker');
  const old = path.join(fixture.config.indexDir, 'runtime/1.0.0-aaaaaaaaaaaaaaaaaaaa'); await mkdir(old);
  await extractAssets(fixture.config.indexDir, manifest, read);
  assert.deepEqual(await readdir(path.dirname(directory)), [path.basename(directory)]);
  await assert.rejects(extractAssets(fixture.config.indexDir, { files: { bad: { sha256: '0'.repeat(64) } } }, read), /Контрольная сумма/u);
  await assert.rejects(extractAssets(fixture.config.indexDir, { files: { '../escape': { sha256: sha256(bytes) } } }, read), /Небезопасное/u);
});

test('runtime symlink is refused', async (context) => {
  const fixture = await tempProject('runtime-link'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await symlink(fixture.docs, path.join(fixture.config.indexDir, 'runtime'));
  await assert.rejects(extractAssets(fixture.config.indexDir, { files: {} }, async () => Buffer.from('')), /символической/u);
});
