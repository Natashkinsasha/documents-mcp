import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { defaultPaths, readConfigFile } from './config.js';
import { safeText } from './cue.js';
import { install, printConnection, uninstall } from './install.js';
import { execute, serviceAction, windowsAdministrator } from './service.js';
import { commandError, terminalIO, type TerminalIO } from './terminal.js';
import { VERSION } from './version.js';

export function wizardMode(args: string[], platform: NodeJS.Platform, interactive: boolean): boolean {
  return platform === 'win32' && ((args.length === 0 && interactive) || (args.length === 1 && args[0] === '--wizard'));
}

export function elevationArguments(executable: string): string[] {
  if (/[\r\n\0]/u.test(executable)) throw new Error('Путь программы содержит недопустимые символы.');
  return ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; Start-Process -FilePath '${executable.replaceAll("'", "''")}' -ArgumentList '--wizard' -Verb RunAs`];
}

export async function pickWindowsFolder(current = ''): Promise<string> {
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='Выберите папку документов'; $dialog.SelectedPath=$env:DOCUMENTS_MCP_FOLDER; try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } } finally { $dialog.Dispose() }";
  return (await execute('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { env: { ...process.env, DOCUMENTS_MCP_FOLDER: current }, maxBuffer: 16_384 })).stdout.trim();
}

export async function copyWindowsKey(key: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('clip.exe', [], { windowsHide: true, timeout: 10_000 }, (error) => error ? reject(new Error('Не удалось скопировать ключ.')) : resolve());
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(key, 'utf16le'));
  });
}

export interface WizardStatus { installed: boolean; settings: NodeJS.ProcessEnv; version: string; taskState: string }

export async function readWizardStatus(): Promise<WizardStatus> {
  const paths = defaultPaths();
  const settings = await readConfigFile(paths.config, true);
  const installed = await stat(paths.binary).then((entry) => entry.isFile(), (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
  const taskState = await serviceAction('status', paths).catch(() => 'не запущена или задача недоступна');
  let version = settings.INSTALLED_VERSION ?? 'неизвестна';
  if (installed) {
    try { version = (await execute(paths.binary, ['--version'], { windowsHide: true, timeout: 10_000 })).stdout.trim().replace(/^documents-mcp /u, ''); } catch {}
  }
  return { installed, settings, version, taskState };
}

export interface WizardDependencies {
  io: TerminalIO;
  status(): Promise<WizardStatus>;
  installer: typeof install;
  uninstaller: typeof uninstall;
  picker: typeof pickWindowsFolder;
  clipboard: typeof copyWindowsKey;
}

export async function runWizard(overrides: Partial<WizardDependencies> = {}): Promise<void> {
  const dependencies: WizardDependencies = { io: terminalIO, status: readWizardStatus, installer: install, uninstaller: uninstall, picker: pickWindowsFolder, clipboard: copyWindowsKey, ...overrides };
  const { io } = dependencies;
  let secrets: string[] = [];
  const folder = async (current = ''): Promise<string> => {
    let selected = '';
    try { selected = await dependencies.picker(current); } catch { io.print('Не удалось открыть выбор папки. Введите путь вручную.'); }
    selected ||= (await io.ask(`Папка документов${current ? ` [${current}]` : ''}: `)).trim() || current;
    if (!selected) throw new Error('Папка документов не выбрана.');
    return selected;
  };
  const copy = async (settings: NodeJS.ProcessEnv): Promise<void> => {
    if (!settings.MCP_TOKEN) throw new Error('Ключ не найден. Установите программу заново.');
    try { await dependencies.clipboard(settings.MCP_TOKEN); io.print('Ключ скопирован в буфер обмена.'); }
    catch { io.print('Предупреждение: не удалось скопировать ключ. Скопируйте «Ключ для Cue» вручную.'); }
  };
  try {
    const status = await dependencies.status();
    secrets = [status.settings.TUNNEL_TOKEN ?? ''];
    if (!status.installed) {
      io.print('Добро пожаловать! Подключим папку документов к Cue.');
      const docs = await folder(status.settings.DOCS_ROOT);
      const allowRemoteUpdate = /^(да|д|yes|y)$/iu.test((await io.ask('Разрешить Cue удалённо устанавливать новые официальные версии с проверенной подписью? Программа сможет обновлять себя с правами SYSTEM. По умолчанию выключено. [да/Нет]: ')).trim());
      const settings = await dependencies.installer({ docs, allowRemoteUpdate });
      await copy(settings);
      return;
    }
    io.print(`Установлена версия: ${status.version}\nВерсия этого файла: ${VERSION}\nЗадача: ${status.taskState}\nПапка: ${status.settings.DOCS_ROOT ?? 'не задана'}\nАдрес: ${status.settings.PUBLIC_URL || `http://127.0.0.1:${status.settings.PORT ?? '3000'}`}`);
    io.print('1 — обновить до этой версии (настройки и ключ сохранятся)\n2 — показать адрес и ключ\n3 — изменить папку документов\n4 — подключить заново к Cue\n5 — удалить\n0 — выход');
    const choice = (await io.ask('Выберите действие [0]: ')).trim() || '0';
    if (choice === '0') return;
    if (choice === '2') { printConnection(status.settings, io.print); await copy(status.settings); return; }
    if (choice === '5') {
      if (!/^(да|д|yes|y)$/iu.test((await io.ask('Удалить программу? Документы не удаляются. [да/Нет]: ')).trim())) { io.print('Удаление отменено.'); return; }
      const purge = /^(да|д|yes|y)$/iu.test((await io.ask('Также удалить настройки, ключ и индекс? Сами документы сохранятся. [да/Нет]: ')).trim());
      await dependencies.uninstaller(purge); return;
    }
    const settings = choice === '1' ? await dependencies.installer({ yes: true })
      : choice === '3' ? await dependencies.installer({ docs: await folder(status.settings.DOCS_ROOT), yes: true })
        : choice === '4' ? await dependencies.installer({ connection: 'cue', docs: status.settings.DOCS_ROOT }) : undefined;
    if (!settings) throw new Error('Выберите действие от 0 до 5.');
    await copy(settings);
  } catch (error) {
    io.print(`Ошибка: ${safeText(commandError(error), secrets)}`);
  } finally {
    await io.ask('Нажмите Enter, чтобы закрыть окно');
  }
}

export interface WizardLaunchDependencies {
  io: TerminalIO; elevated(): Promise<boolean>; relaunch(executable: string): Promise<void>; wizard(): Promise<void>;
}

export async function launchWindowsWizard(executable = process.execPath, overrides: Partial<WizardLaunchDependencies> = {}): Promise<void> {
  const dependencies: WizardLaunchDependencies = {
    io: terminalIO, elevated: windowsAdministrator,
    relaunch: async (file) => { await execute('powershell.exe', elevationArguments(file), { windowsHide: true }); },
    wizard: runWizard, ...overrides,
  };
  try {
    if (await dependencies.elevated()) { await dependencies.wizard(); return; }
    await dependencies.relaunch(executable);
  } catch {
    dependencies.io.print('Для установки и управления программой нужны права администратора. Подтвердите запрос Windows (UAC) и попробуйте снова.');
    await dependencies.io.ask('Нажмите Enter, чтобы закрыть окно');
  }
}
