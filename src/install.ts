import { randomBytes } from 'node:crypto';
import { access, chmod, chown, copyFile, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isSea } from 'node:sea';
import { defaultPaths, loadConfig, normalizePublicUrl, readConfigFile, serializeConfig } from './config.js';
import { execute, requireAdministrator, restrictWindows, serviceAction, systemdUnit, writeSystemdUnit, windowsTask, type InstallPaths } from './service.js';
import { connectionOptions, type ConnectionOptions } from './connection.js';
import { claimCue } from './cue.js';
import { terminalIO, type TerminalIO } from './terminal.js';
import { VERSION } from './version.js';

export interface InstallOptions extends ConnectionOptions { docs?: string; user?: string }
export function documentAclFix(user: string, docs: string, readOnly = false): string {
  const permission = readOnly ? 'rX' : 'rwX';
  const quoted = `'${docs.replaceAll("'", "'\\''")}'`;
  return `setfacl -R -m u:${user}:${permission} ${quoted}; setfacl -R -d -m u:${user}:${permission} ${quoted}`;
}
export function upgradeSettings(previous: NodeJS.ProcessEnv, options: InstallOptions, paths: InstallPaths): NodeJS.ProcessEnv {
  const settings = { ...previous };
  settings.DOCS_ROOT = options.docs ?? settings.DOCS_ROOT;
  settings.TUNNEL_TOKEN = options.tunnelToken ?? settings.TUNNEL_TOKEN ?? '';
  settings.PUBLIC_URL = normalizePublicUrl(options.publicUrl ?? settings.PUBLIC_URL ?? '');
  settings.PORT = options.port ?? settings.PORT ?? '3000';
  settings.SERVICE_USER = options.user ?? settings.SERVICE_USER ?? 'documents-mcp';
  settings.MCP_TOKEN ||= randomBytes(32).toString('hex');
  settings.INDEX_DIR = paths.data;
  settings.HOST = '127.0.0.1';
  settings.INSTALLED_VERSION = VERSION;
  if (process.env.READ_ONLY !== undefined) settings.READ_ONLY = process.env.READ_ONLY;
  return settings;
}

export async function waitForHealth(url: string, timeoutMs = 60_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  do {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(3000, Math.max(1, end - Date.now()))), redirect: 'error' }); if (response.ok && (await response.text()).trim() === 'ok') return true; await response.body?.cancel(); } catch {}
    await delay(Math.min(500, Math.max(0, end - Date.now())));
  } while (Date.now() < end);
  return false;
}

export function printConnection(settings: NodeJS.ProcessEnv, print: TerminalIO['print'] = terminalIO.print): void {
  const url = settings.PUBLIC_URL ? `${settings.PUBLIC_URL}/mcp` : `http://127.0.0.1:${settings.PORT ?? '3000'}/mcp`;
  print(`Адрес: ${settings.PUBLIC_URL || `http://127.0.0.1:${settings.PORT ?? '3000'}`}\nURL: ${url}\nКлюч для Cue: ${settings.MCP_TOKEN ?? 'не задан'}\nЗаголовок: Authorization: Bearer ${settings.MCP_TOKEN ?? 'не задан'}`);
  print('Вставьте этот ключ в Cue: Коннекторы → Документы компании → Ключ из программы → Проверить и подключить');
  if (!settings.PUBLIC_URL) print('Публичный URL не задан. Без туннеля доступ только с этого компьютера.');
}

export interface InstallDependencies {
  platform: NodeJS.Platform; sea: boolean; paths: InstallPaths; io: TerminalIO;
  administrator: typeof requireAdministrator; readSettings: typeof readConfigFile;
  claim: typeof claimCue; health: typeof waitForHealth;
  deploy: typeof deployInstallation;
}

export async function install(input: InstallOptions, overrides: Partial<InstallDependencies> = {}): Promise<NodeJS.ProcessEnv> {
  const dependencies: InstallDependencies = { platform: process.platform, sea: isSea(), paths: defaultPaths(), io: terminalIO, administrator: requireAdministrator, readSettings: readConfigFile, claim: claimCue, health: waitForHealth, deploy: deployInstallation, ...overrides };
  await dependencies.administrator();
  if (!['linux', 'win32'].includes(dependencies.platform)) throw new Error('Служба поддерживается в Linux с systemd и Windows. Для macOS используйте run.');
  if (!dependencies.sea) throw new Error('Установку выполняет единый исполняемый файл documents-mcp, а не исходный код под Node.js.');
  const paths = dependencies.paths;
  const previous = await dependencies.readSettings(paths.config, true);
  const options: InstallOptions = { ...input, ...await connectionOptions(previous, input, dependencies.io, dependencies.claim) };
  delete options.cueCode; delete options.cueAddress;
  if (!options.yes) {
    options.docs ??= await dependencies.io.ask(`Папка документов${previous.DOCS_ROOT ? ` [${previous.DOCS_ROOT}]` : ''}: `) || previous.DOCS_ROOT;
  }
  const settings = upgradeSettings(previous, options, paths);
  await dependencies.deploy(settings, options, previous, paths);
  if (!await dependencies.health(`http://127.0.0.1:${settings.PORT}/healthz`)) throw new Error('Служба установлена, но не ответила за 60 секунд. Проверьте status и журнал службы.');
  if (settings.PUBLIC_URL) {
    dependencies.io.print('Проверяем публичный адрес (до 60 секунд)…');
    if (await dependencies.health(`${settings.PUBLIC_URL}/healthz`)) dependencies.io.print('Туннель работает: публичный адрес ответил ok.');
    else dependencies.io.print('Предупреждение: публичный адрес пока не отвечает ok. Проверьте DNS и маршрут туннеля; служба работает локально.');
  }
  dependencies.io.print('Служба установлена и запущена.');
  printConnection(settings, dependencies.io.print);
  return settings;
}

async function deployInstallation(settings: NodeJS.ProcessEnv, options: InstallOptions, previous: NodeJS.ProcessEnv, paths: InstallPaths): Promise<void> {
  if (!settings.DOCS_ROOT || !path.isAbsolute(settings.DOCS_ROOT)) throw new Error('Укажите существующую абсолютную папку: --docs <путь>.');
  const docs = await realpath(settings.DOCS_ROOT);
  if (!(await stat(docs)).isDirectory()) throw new Error('Указанный путь не является папкой.');
  await access(docs, constants.R_OK | constants.X_OK);
  settings.DOCS_ROOT = docs;
  if (process.platform === 'win32' && (options.user || docs.startsWith('\\\\'))) throw new Error('Задача запускается от SYSTEM. Сетевые папки UNC и --user не поддерживаются: выберите локальную папку или настройте отдельную задачу с доменной учётной записью вручную.');
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  await loadConfig(settings);
  let identity: { uid: number; gid: number } | undefined;
  if (process.platform === 'linux') {
    const user = settings.SERVICE_USER!;
    systemdUnit(paths, docs, user, settings.READ_ONLY === '1');
    try { await execute('id', ['-u', user]); }
    catch {
      if (options.user || previous.SERVICE_USER) throw new Error('Пользователь службы не существует. Создайте его или измените --user.');
      await execute('useradd', ['--system', '--user-group', '--home-dir', paths.data, '--no-create-home', '--shell', '/usr/sbin/nologin', user]);
    }
    identity = { uid: Number((await execute('id', ['-u', user])).stdout.trim()), gid: Number((await execute('id', ['-g', user])).stdout.trim()) };
    try {
      await execute('runuser', ['-u', user, '--', 'test', '-r', docs]);
      await execute('runuser', ['-u', user, '--', 'test', '-x', docs]);
      if (settings.READ_ONLY !== '1') await execute('runuser', ['-u', user, '--', 'test', '-w', docs]);
    } catch {
      throw new Error(`Пользователю ${user} нужны чтение, проход${settings.READ_ONLY === '1' ? '' : ' и запись'}. Выполните: ${documentAclFix(user, docs, settings.READ_ONLY === '1')}; для каждого родительского каталога — setfacl -m u:${user}:x <каталог>. Либо укажите --user <существующий пользователь с доступом>.`);
    }
    await execute('chown', ['-R', '--no-dereference', `${identity.uid}:${identity.gid}`, paths.data]);
  }
  await mkdir(path.dirname(paths.config), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.binary), { recursive: true });
  if (process.platform === 'win32') { await restrictWindows(paths.data); await restrictWindows(path.dirname(paths.binary)); }
  await serviceAction('stop', paths).catch(() => {});
  if (path.resolve(process.execPath) !== path.resolve(paths.binary)) {
    const stagedBinary = `${paths.binary}.new`;
    await copyFile(process.execPath, stagedBinary); await chmod(stagedBinary, 0o755);
    if (process.platform === 'win32') await rm(paths.binary, { force: true });
    await rename(stagedBinary, paths.binary);
  }
  const stagedConfig = `${paths.config}.new`;
  await writeFile(stagedConfig, serializeConfig(settings), { mode: 0o600 });
  if (identity) { await chown(path.dirname(paths.config), 0, identity.gid); await chmod(path.dirname(paths.config), 0o750); await chown(stagedConfig, identity.uid, identity.gid); }
  if (process.platform === 'win32') await rm(paths.config, { force: true });
  await rename(stagedConfig, paths.config); await chmod(paths.config, 0o600);
  if (process.platform === 'linux') {
    await writeSystemdUnit(paths, docs, settings.SERVICE_USER!, settings.READ_ONLY === '1');
    await execute('systemctl', ['daemon-reload']);
  } else {
    await writeFile(paths.service, Buffer.from(`\ufeff${windowsTask(paths)}`, 'utf16le'));
    await execute('schtasks.exe', ['/Create', '/TN', 'documents-mcp', '/XML', paths.service, '/F'], { windowsHide: true });
  }
  await serviceAction('start', paths);
}

export async function uninstall(purge: boolean): Promise<void> {
  await requireAdministrator();
  const paths = defaultPaths();
  await serviceAction('stop', paths).catch(() => {});
  await serviceAction('remove', paths);
  await rm(paths.service, { force: true });
  if (process.platform === 'linux') await execute('systemctl', ['daemon-reload']);
  if (process.platform === 'win32' && path.resolve(process.execPath) === path.resolve(paths.binary)) {
    const script = '$p=$env:DOCUMENTS_MCP_REMOVE; Start-Sleep -Seconds 2; Remove-Item -LiteralPath $p -Force';
    const { spawn } = await import('node:child_process');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DOCUMENTS_MCP_REMOVE: paths.binary }, detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
  } else await rm(paths.binary, { force: true });
  if (purge) { await rm(paths.config, { force: true }); await rm(paths.data, { recursive: true, force: true }); }
  console.log(purge ? 'Служба, программа, настройки и индекс удалены.' : 'Служба и программа удалены. Настройки и индекс сохранены.');
}
