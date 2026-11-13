import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from './types.js';

export class TunnelSupervisor {
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private attempts = 0;
  constructor(private readonly binary: string, private readonly token: string, private readonly logger: Logger, private readonly minimumDelay = 1000, private readonly maximumDelay = 30_000) {}
  start(): void {
    if (this.stopping || this.child || this.timer) return;
    const environment: NodeJS.ProcessEnv = { TUNNEL_TOKEN: this.token };
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) environment[key] = process.env[key];
    const started = Date.now();
    const child = spawn(this.binary, ['tunnel', '--no-autoupdate', 'run'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? '';
        for (const line of lines) this.line(line);
        if (pending.length > 65_536) pending = '';
      });
      stream?.on('end', () => { if (pending) this.line(pending); });
    }
    child.on('error', () => this.logger({ level: 'warn', message: '[tunnel] Не удалось запустить туннель.' }));
    child.once('close', () => {
      if (this.child === child) this.child = undefined;
      if (this.stopping) return;
      if (Date.now() - started > 60_000) this.attempts = 0;
      const delay = Math.min(this.maximumDelay, this.minimumDelay * 2 ** Math.min(this.attempts++, 16));
      this.logger({ level: 'warn', message: '[tunnel] Туннель остановлен; повторный запуск.', delay_ms: delay });
      this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
    });
  }
  private line(line: string): void {
    this.logger({ level: 'info', message: `[tunnel] ${line.replaceAll(this.token, '[скрыто]').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '').slice(0, 4096)}` });
  }
  async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.timer); this.timer = undefined;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
