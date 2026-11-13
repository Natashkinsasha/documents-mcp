import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPaths } from '../src/config.js';
import { systemdUnit, writeSystemdUnit, windowsTask } from '../src/service.js';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tempProject } from './helpers.js';
import { documentAclFix, upgradeSettings } from '../src/install.js';

test('systemd unit has boot activation, restart, hardening and writable documents by default', () => {
  const unit = systemdUnit(defaultPaths('linux'), '/srv/Company docs%/$folder', 'documents-mcp');
  for (const line of ['Restart=always', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=read-only', 'ReadWritePaths="/var/lib/documents-mcp"', 'PrivateTmp=yes', 'WantedBy=multi-user.target', 'User=documents-mcp', 'ReadWritePaths="/srv/Company docs%%/$folder"']) assert.ok(unit.includes(line), line);
  assert.ok(!unit.includes('MCP_TOKEN')); assert.throws(() => systemdUnit(defaultPaths('linux'), '/docs\nExecStart=evil', 'root'));
  assert.ok(unit.includes('\nWorkingDirectory=/var/lib/documents-mcp\n'));
});

test('read-only opt-out and upgrade regenerate the correct unit', () => {
  const paths = defaultPaths('linux');
  const previous = { DOCS_ROOT: '/docs', READ_ONLY: '1' };
  assert.match(systemdUnit(paths, '/docs', 'documents-mcp', true), /ReadOnlyPaths="\/docs"/u);
  const settings = upgradeSettings({ DOCS_ROOT: '/docs' }, {}, paths);
  assert.doesNotMatch(systemdUnit(paths, settings.DOCS_ROOT!, settings.SERVICE_USER!, settings.READ_ONLY === '1'), /ReadOnlyPaths=/u);
  assert.match(systemdUnit(paths, '/docs', 'documents-mcp'), /ReadWritePaths="\/docs"/u);
  const optedOut = upgradeSettings(previous, {}, paths);
  assert.match(systemdUnit(paths, optedOut.DOCS_ROOT!, optedOut.SERVICE_USER!, optedOut.READ_ONLY === '1'), /ReadOnlyPaths=/u);
});

test('installation rewrites an existing read-only unit during upgrade', async (context) => {
  const fixture = await tempProject('unit-upgrade');
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const paths = { ...defaultPaths('linux'), service: path.join(fixture.directory, 'documents-mcp.service') };
  await writeSystemdUnit(paths, fixture.docs, 'documents-mcp', true);
  assert.match(await readFile(paths.service, 'utf8'), /ReadOnlyPaths=/u);
  await writeSystemdUnit(paths, fixture.docs, 'documents-mcp');
  assert.doesNotMatch(await readFile(paths.service, 'utf8'), /ReadOnlyPaths=/u);
  assert.ok((await readFile(paths.service, 'utf8')).includes(`ReadWritePaths="${fixture.docs}"`));
});

test('installer ACL fixes include recursive write/default permissions and shell-safe paths', () => {
  assert.equal(documentAclFix('documents-mcp', '/srv/docs'), "setfacl -R -m u:documents-mcp:rwX '/srv/docs'; setfacl -R -d -m u:documents-mcp:rwX '/srv/docs'");
  assert.match(documentAclFix('documents-mcp', "/srv/it's $(not-a-command)"), /it'\\''s/u);
  assert.ok(!documentAclFix('documents-mcp', '/srv/docs', true).includes(':rwX'));
});

test('Windows task runs at boot as SYSTEM without logon and restarts on failure', () => {
  const task = windowsTask(defaultPaths('win32', { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' }));
  for (const text of ['<BootTrigger>', '<UserId>S-1-5-18</UserId>', '<LogonType>ServiceAccount</LogonType>', '<RestartOnFailure>', '<Interval>PT1M</Interval>', '<Count>999</Count>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>']) assert.ok(task.includes(text), text);
  assert.ok(!task.includes('MCP_TOKEN'));
});

test('install upgrade preserves existing token and settings unless flags override them', () => {
  const first = upgradeSettings({}, { docs: '/docs', tunnelToken: 'secret', publicUrl: 'example.com' }, defaultPaths('linux'));
  assert.match(first.MCP_TOKEN!, /^[a-f0-9]{64}$/u);
  const second = upgradeSettings(first, {}, defaultPaths('linux')); assert.deepEqual(second, first);
  const third = upgradeSettings(second, { docs: '/new', tunnelToken: '', port: '4500' }, defaultPaths('linux'));
  assert.equal(third.MCP_TOKEN, first.MCP_TOKEN); assert.equal(third.TUNNEL_TOKEN, ''); assert.equal(third.DOCS_ROOT, '/new'); assert.equal(third.PORT, '4500');
});
