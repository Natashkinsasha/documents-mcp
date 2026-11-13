import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PathGuard } from '../src/paths.js';
import { tempProject } from './helpers.js';

test('path guard rejects traversal, absolute paths, escaping and hidden symlinks, ignores and loops', async (context) => {
  const fixture = await tempProject('paths');
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await mkdir(path.join(fixture.docs, 'sub'));
  await mkdir(path.join(fixture.docs, '.hidden'));
  await writeFile(path.join(fixture.directory, 'outside.txt'), 'outside');
  for (const name of ['ok.txt', '.secret', '~$temp.docx', 'Thumbs.db', 'desktop.ini', 'ignored.bak']) await writeFile(path.join(fixture.docs, name), 'text');
  await writeFile(path.join(fixture.docs, '.hidden', 'secret.txt'), 'hidden');
  await symlink(path.join(fixture.directory, 'outside.txt'), path.join(fixture.docs, 'escape.txt'));
  await symlink(path.join(fixture.docs, '.secret'), path.join(fixture.docs, 'alias.txt'));
  await symlink(fixture.docs, path.join(fixture.docs, 'sub', 'loop'));
  const guard = new PathGuard(await realpath(fixture.docs), ['**/*.bak']);
  for (const input of ['../outside.txt', 'sub/../../outside.txt', '/etc/passwd', 'C:/secret', 'a\\b', 'bad\0.txt', 'escape.txt', 'alias.txt', '.secret', '.hidden/secret.txt', '~$temp.docx', 'Thumbs.db', 'desktop.ini', 'ignored.bak', 'missing.txt']) {
    await assert.rejects(guard.resolve(input), { message: 'Документ или папка не найден(а).' }, input);
  }
  assert.equal((await guard.resolve('sub/../ok.txt').catch(() => null)), null);
  assert.equal((await guard.resolve('./ok.txt', 'file')).relative, 'ok.txt');
  const files: string[] = [];
  for await (const file of guard.walk()) files.push(file);
  assert.deepEqual(files, ['ok.txt']);
});
