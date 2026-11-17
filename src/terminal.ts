import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface TerminalIO {
  ask(question: string, secret?: boolean): Promise<string>;
  print(message: string): void;
}

export async function ask(question: string, secret = false): Promise<string> {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    if (secret && process.stdin.isTTY) { process.stdout.write(question); muted = true; return await terminal.question(''); }
    return await terminal.question(question);
  } finally { terminal.close(); if (muted) process.stdout.write('\n'); }
}

export const terminalIO: TerminalIO = { ask, print: (message) => console.log(message) };

const SYSTEM_ERRORS: Record<string, string> = {
  EBUSY: 'файл занят другим процессом', EPERM: 'нет прав или файл занят', EACCES: 'нет доступа', ENOENT: 'файл или папка не найдены',
  EADDRINUSE: 'порт занят', ENOSPC: 'нет места на диске', EEXIST: 'файл уже существует',
};

export function commandError(error: unknown): string {
  if (error instanceof Error && !('code' in error) && !(error instanceof SyntaxError)) return error.message;
  const generic = 'Не удалось выполнить команду. Проверьте настройки, права, журнал службы и занятость порта.';
  // Name the system error by its code only: the code carries no paths or credentials, yet tells which step failed.
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/u.test(error.code) ? error.code : undefined;
  return code ? `${generic} Код ошибки: ${code}${SYSTEM_ERRORS[code] ? ` (${SYSTEM_ERRORS[code]})` : ''}.` : generic;
}
