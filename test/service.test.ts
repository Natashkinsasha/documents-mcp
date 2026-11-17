import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPaths } from '../src/config.js';
import { systemdUnit, writeSystemdUnit, windowsTask } from '../src/service.js';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tempProject } from './helpers.js';
import { defaultIndexDir, documentAclFix, upgradeSettings, whileBusy } from '../src/install.js';
import { commandError } from '../src/terminal.js';

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
  for (const text of ['<BootTrigger>', '<UserId>S-1-5-18</UserId>', '<RestartOnFailure>', '<Interval>PT1M</Interval>', '<Count>999</Count>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>']) assert.ok(task.includes(text), text);
  assert.ok(!task.includes('MCP_TOKEN'));
  // Windows Server 2022 rejects LogonType=ServiceAccount in an imported task ("value ... out of range"); SYSTEM needs no logon type.
  assert.ok(!task.includes('<LogonType>'));
});

test('a new Windows install keeps its index on the documents drive, not the system drive', () => {
  const paths = defaultPaths('win32', { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' });
  assert.equal(defaultIndexDir('E:\\Документооборот', paths, 'win32'), 'E:\\documents-mcp-data');
  assert.equal(defaultIndexDir('C:\\Docs', paths, 'win32'), paths.data);
  assert.equal(defaultIndexDir('/srv/docs', defaultPaths('linux'), 'linux'), defaultPaths('linux').data);
  const first = upgradeSettings({}, { docs: 'E:\\Документооборот' }, paths, 'win32');
  assert.equal(first.INDEX_DIR, 'E:\\documents-mcp-data');
  // Upgrades, folder changes and reconnects keep the index where it already is.
  assert.equal(upgradeSettings({ DOCS_ROOT: 'E:\\Docs', INDEX_DIR: 'C:\\ProgramData\\documents-mcp' }, { docs: 'D:\\Other' }, paths, 'win32').INDEX_DIR, 'C:\\ProgramData\\documents-mcp');
  assert.equal(upgradeSettings(first, { indexDir: 'F:\\index' }, paths, 'win32').INDEX_DIR, 'F:\\index');
});

test('systemd unit can write an index kept outside the data directory', () => {
  const paths = defaultPaths('linux');
  assert.ok(systemdUnit(paths, '/docs', 'documents-mcp', true, '/mnt/big/index').includes('ReadWritePaths="/mnt/big/index"'));
  assert.equal(systemdUnit(paths, '/docs', 'documents-mcp', true, paths.data).match(/ReadWritePaths=/gu)?.length, 1);
});

test('install upgrade preserves existing token and settings unless flags override them', () => {
  const first = upgradeSettings({}, { docs: '/docs', tunnelToken: 'secret', publicUrl: 'example.com' }, defaultPaths('linux'));
  assert.match(first.MCP_TOKEN!, /^[a-f0-9]{64}$/u);
  const second = upgradeSettings(first, {}, defaultPaths('linux')); assert.deepEqual(second, first);
  const third = upgradeSettings(second, { docs: '/new', tunnelToken: '', port: '4500' }, defaultPaths('linux'));
  assert.equal(third.MCP_TOKEN, first.MCP_TOKEN); assert.equal(third.TUNNEL_TOKEN, ''); assert.equal(third.DOCS_ROOT, '/new'); assert.equal(third.PORT, '4500');
});

test('replacing a locked Windows executable waits for the old process, then ends it once', async () => {
  const locked = (code: string) => Object.assign(new Error('locked'), { code });
  let attempts = 0; let forced = 0;
  await whileBusy(async () => { if (++attempts < 4) throw locked('EBUSY'); }, async () => { forced++; }, { timeoutMs: 1000, forceAfterMs: 0, stepMs: 1 });
  assert.equal(attempts, 4); assert.equal(forced, 1);
  await assert.rejects(whileBusy(async () => { throw locked('ENOSPC'); }, async () => {}, { stepMs: 1 }), /locked/u);
  await assert.rejects(whileBusy(async () => { throw locked('EPERM'); }, async () => {}, { timeoutMs: 20, forceAfterMs: 5, stepMs: 1 }), /locked/u);
});

test('a system error names its code without leaking the path', () => {
  const error = Object.assign(new Error("EBUSY: resource busy or locked, unlink 'C:\\Program Files\\documents-mcp\\documents-mcp.exe'"), { code: 'EBUSY' });
  const message = commandError(error);
  assert.match(message, /Код ошибки: EBUSY \(файл занят другим процессом\)/u);
  assert.doesNotMatch(message, /Program Files/u);
  assert.equal(commandError(new Error('Понятная ошибка')), 'Понятная ошибка');
});
