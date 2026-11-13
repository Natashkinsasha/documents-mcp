import { claimCue, normalizeCueAddress, normalizeCueCode, type CueConnection } from './cue.js';
import { terminalIO, type TerminalIO } from './terminal.js';

export interface ConnectionOptions {
  cueAddress?: string; cueCode?: string; tunnelToken?: string; publicUrl?: string; port?: string;
  connection?: 'cue' | 'tunnel' | 'local'; yes?: boolean;
}

export const CONNECTION_QUESTION = 'Как подключить к Cue?\n1 — Адрес и код из Cue (рекомендуется)\n2 — Свой туннель Cloudflare (токен)\n3 — Только на этом компьютере';

export async function connectionOptions(previous: NodeJS.ProcessEnv, options: ConnectionOptions, io: TerminalIO = terminalIO, claim: typeof claimCue = claimCue): Promise<ConnectionOptions> {
  const selected = { ...options };
  const hasCue = selected.cueAddress !== undefined || selected.cueCode !== undefined;
  const hasTunnel = selected.tunnelToken !== undefined || selected.publicUrl !== undefined;
  if ((hasCue && hasTunnel) || (selected.connection === 'cue' && hasTunnel) || (hasCue && selected.connection && selected.connection !== 'cue') || (selected.connection === 'local' && hasTunnel)) throw new Error('Выберите один способ подключения: адрес и код из Cue, свой туннель или локальный доступ.');
  if (hasCue) selected.connection = 'cue';
  else if (hasTunnel) selected.connection ??= 'tunnel';
  if (!selected.connection && !selected.yes) {
    const keeping = Boolean(previous.MCP_TOKEN);
    io.print(CONNECTION_QUESTION);
    if (keeping) io.print('Enter — сохранить текущее подключение.');
    const choice = (await io.ask(keeping ? 'Способ подключения [сохранить]: ' : 'Способ подключения [1]: ')).trim() || (keeping ? 'keep' : '1');
    if (choice === 'keep') return selected;
    selected.connection = choice === '1' ? 'cue' : choice === '2' ? 'tunnel' : choice === '3' ? 'local' : undefined;
    if (!selected.connection) throw new Error('Выберите способ подключения: 1, 2 или 3.');
  }
  if (selected.connection === 'cue') {
    if (!selected.yes) {
      selected.cueAddress ??= await io.ask('Адрес из Cue (например vs.cuechat.org): ');
      selected.cueCode ??= await io.ask('Одноразовый код из Cue: ', true);
    }
    if (!selected.cueAddress || !selected.cueCode) throw new Error('Укажите и --cue-address, и --cue-code.');
    const host = normalizeCueAddress(selected.cueAddress);
    const code = normalizeCueCode(selected.cueCode);
    const connection: CueConnection = await claim(host, code, { progress: io.print });
    selected.tunnelToken = connection.tunnelToken;
    selected.publicUrl = connection.publicUrl;
    selected.port = String(connection.port);
  } else if (selected.connection === 'local') {
    selected.tunnelToken = ''; selected.publicUrl = '';
  } else if (selected.connection === 'tunnel' && !selected.yes) {
    selected.tunnelToken ??= await io.ask('Токен Cloudflare Tunnel (ввод скрыт): ', true);
    selected.publicUrl ??= await io.ask('Публичный HTTPS-адрес (необязательно): ');
  }
  delete selected.cueCode;
  delete selected.cueAddress;
  return selected;
}
