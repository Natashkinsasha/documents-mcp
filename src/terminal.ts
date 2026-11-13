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

export function commandError(error: unknown): string {
  return error instanceof Error && !('code' in error) && !(error instanceof SyntaxError) ? error.message : 'Не удалось выполнить команду. Проверьте настройки, права, журнал службы и занятость порта.';
}
