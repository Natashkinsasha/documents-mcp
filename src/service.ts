import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { defaultPaths } from './config.js';

export const execute = promisify(execFile);
export type InstallPaths = ReturnType<typeof defaultPaths>;
const unitQuoted = (value: string, command = false): string => {
  if (/[\r\n\0]/u.test(value)) throw new Error('Путь содержит недопустимые символы.');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => command ? '$$' : '$')}"`;
};
export function systemdUnit(paths: InstallPaths, docs: string, user: string, readOnly = false): string {
  if (!/^[a-z_][a-z0-9_-]*\$?$/iu.test(user)) throw new Error('Недопустимое имя пользователя службы.');
  return `[Unit]\nDescription=Document MCP server\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${user}\nExecStart=${unitQuoted(paths.binary, true)} run --config ${unitQuoted(paths.config, true)}\nWorkingDirectory=${paths.data.replaceAll('%', '%%')}\nRestart=always\nRestartSec=3\nUMask=0077\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${unitQuoted(paths.data)}\nPrivateTmp=yes\n${readOnly ? 'ReadOnlyPaths' : 'ReadWritePaths'}=${unitQuoted(docs)}\nTimeoutStopSec=15\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export async function writeSystemdUnit(paths: InstallPaths, docs: string, user: string, readOnly = false): Promise<void> {
  await writeFile(paths.service, systemdUnit(paths, docs, user, readOnly), { mode: 0o644 });
}
const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function windowsTask(paths: InstallPaths): string {
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Document MCP server</Description></RegistrationInfo><Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT10S</Delay></BootTrigger></Triggers><Principals><Principal id="System"><UserId>S-1-5-18</UserId><LogonType>ServiceAccount</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="System"><Exec><Command>${xml(paths.binary)}</Command><Arguments>run --config &quot;${xml(paths.config)}&quot;</Arguments><WorkingDirectory>${xml(paths.data)}</WorkingDirectory></Exec></Actions></Task>\n`;
}

export async function requireAdministrator(): Promise<void> {
  if (process.platform === 'win32') {
    try { await execute('fltmc.exe', [], { windowsHide: true }); return; } catch {}
    throw new Error('Запустите терминал от имени Администратора.');
  }
  if (process.getuid?.() !== 0) throw new Error('Команда требует root. Запустите её через sudo.');
}

export async function restrictWindows(directory: string): Promise<void> {
  await execute('icacls.exe', [directory, '/reset', '/T'], { windowsHide: true });
  await execute('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true });
}

export async function serviceAction(action: 'stop' | 'start' | 'remove' | 'status', paths: InstallPaths): Promise<string> {
  if (process.platform === 'linux') {
    const args = action === 'start' ? ['enable', '--now', 'documents-mcp.service'] : action === 'remove' ? ['disable', '--now', 'documents-mcp.service'] : action === 'status' ? ['is-active', 'documents-mcp.service'] : ['stop', 'documents-mcp.service'];
    return (await execute('systemctl', args, { timeout: 30_000 })).stdout.trim();
  }
  if (process.platform === 'win32') {
    const args = action === 'start' ? ['/Run', '/TN', 'documents-mcp'] : action === 'remove' ? ['/Delete', '/TN', 'documents-mcp', '/F'] : action === 'status' ? ['/Query', '/TN', 'documents-mcp', '/FO', 'LIST'] : ['/End', '/TN', 'documents-mcp'];
    return (await execute('schtasks.exe', args, { windowsHide: true, timeout: 30_000 })).stdout.trim();
  }
  throw new Error('Установка службы поддерживается только в Linux с systemd и Windows. На macOS доступна команда run.');
}
