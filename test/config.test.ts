import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, symlink, access, writeFile } from 'node:fs/promises';
import { loadConfig, configEnvironment, parseConfigFile, serializeConfig } from '../src/config.js';
import { tempProject } from './helpers.js';
import { authorized } from '../src/http.js';

test('configuration rejects unsafe paths, secrets, numeric ranges and invalid language names', async (context) => {
  const fixture = await tempProject('config'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const base = { DOCS_ROOT: fixture.docs, INDEX_DIR: path.join(fixture.directory, 'other-index'), MCP_TOKEN: 'x'.repeat(32) };
  for (const change of [{ DOCS_ROOT: '' }, { DOCS_ROOT: 'relative' }, { MCP_TOKEN: 'short' }, { MCP_TOKEN: ' '.repeat(32) }, { PORT: '0' }, { PORT: 'NaN' }, { PORT: '1.5' }, { RESCAN_MINUTES: '-1' }, { MAX_FILE_MB: '0' }, { OCR_MAX_PAGES: '0' }, { OCR_LANGS: 'eng+--bad' }, { INDEX_DIR: fixture.docs }, { INDEX_DIR: path.join(fixture.docs, 'index') }]) await assert.rejects(loadConfig({ ...base, ...change }));
  await mkdir(path.join(fixture.docs, 'hidden-index'));
  await symlink(path.join(fixture.docs, 'hidden-index'), path.join(fixture.directory, 'index-alias'));
  await assert.rejects(loadConfig({ ...base, INDEX_DIR: path.join(fixture.directory, 'index-alias') }));
  await assert.rejects(loadConfig({ ...base, INDEX_DIR: path.join(fixture.directory, 'index-alias', 'new-directory') }));
  await assert.rejects(access(path.join(fixture.docs, 'hidden-index', 'new-directory')));
  assert.ok(authorized(`Bearer ${base.MCP_TOKEN}`, base.MCP_TOKEN));
  for (const value of [undefined, 'Bearer wrong', 'Basic x', `Bearer ${base.MCP_TOKEN} `]) assert.equal(authorized(value, base.MCP_TOKEN), false);
});

test('config file is literal, environment overrides it and tunnel forces loopback', async (context) => {
  const fixture = await tempProject('config-file'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const file = path.join(fixture.directory, 'config.env');
  const settings = { DOCS_ROOT: fixture.docs, INDEX_DIR: fixture.config.indexDir, MCP_TOKEN: 'x'.repeat(64), PORT: '3456', TUNNEL_TOKEN: 'test-token', HOST: '0.0.0.0', IGNORE: '$(touch nope),**/*.bak' };
  await writeFile(file, serializeConfig(settings));
  assert.deepEqual(parseConfigFile(serializeConfig(settings)), settings);
  const config = await loadConfig(await configEnvironment(file, { PORT: '4567', OCR_LANGS: 'rus+bel' }, false));
  assert.equal(config.port, 4567); assert.equal(config.host, '127.0.0.1'); assert.deepEqual(config.ocrLangs, ['rus', 'bel']);
  assert.deepEqual(config.ignore, ['$(touch nope)', '**/*.bak']);
  await assert.rejects(loadConfig({ ...settings, OCR_LANGS: 'deu' }));
  await assert.rejects(configEnvironment(file + '.missing', {}, false));
});
