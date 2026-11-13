import { realpath, mkdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface Config {
  docsRoot: string; indexDir: string; token: string; port: number; host: string;
  ocrLangs: string[]; rescanMinutes: number; maxFileBytes: number; ocrMaxPages: number; ignore: string[];
  tunnelToken: string; publicUrl: string; readOnly?: boolean;
}

export function defaultPaths(platform: NodeJS.Platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const data = path.win32.join(env.ProgramData ?? 'C:\\ProgramData', 'documents-mcp');
    return { binary: path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'documents-mcp', 'documents-mcp.exe'), config: path.win32.join(data, 'config.env'), data, service: path.win32.join(data, 'task.xml') };
  }
  if (platform === 'darwin') {
    const data = path.join(os.homedir(), 'Library/Application Support/documents-mcp');
    return { binary: '/usr/local/bin/documents-mcp', config: path.join(data, 'config.env'), data, service: '' };
  }
  return { binary: '/usr/local/bin/documents-mcp', config: '/etc/documents-mcp/config.env', data: '/var/lib/documents-mcp', service: '/etc/systemd/system/documents-mcp.service' };
}

export function parseConfigFile(text: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  for (const source of text.split(/\r?\n/u)) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error('Некорректная строка файла настроек.');
    const value = match[2]!.trim();
    values[match[1]!] = value.startsWith('"') ? JSON.parse(value) as string : value;
    if (typeof values[match[1]!] !== 'string' || /[\r\n\0]/u.test(values[match[1]!]!)) throw new Error('Некорректное значение настройки.');
  }
  return values;
}

export function serializeConfig(values: NodeJS.ProcessEnv): string {
  return Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}

export async function readConfigFile(file: string, optional = false): Promise<NodeJS.ProcessEnv> {
  try { return parseConfigFile(await readFile(file, 'utf8')); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

export async function configEnvironment(file = defaultPaths().config, env = process.env, optional = true): Promise<NodeJS.ProcessEnv> {
  return { ...await readConfigFile(file, optional), ...Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined)) };
}

export function normalizePublicUrl(value: string): string {
  if (!value) return '';
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname)) throw new Error('PUBLIC_URL должен быть HTTPS-адресом без пути, пароля и параметров.');
  return url.origin;
}

function numberSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number, integer = true): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name}: укажите ${integer ? 'целое число' : 'число'} больше нуля и не больше ${max}.`);
  }
  return value;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  if (!env.DOCS_ROOT || !path.isAbsolute(env.DOCS_ROOT)) throw new Error('DOCS_ROOT: укажите абсолютный путь к папке.');
  const docsRoot = await realpath(env.DOCS_ROOT).catch(() => { throw new Error('DOCS_ROOT: папка должна существовать и быть доступной.'); });
  if (!(await stat(docsRoot)).isDirectory()) throw new Error('DOCS_ROOT должен указывать на папку.');
  const token = env.MCP_TOKEN ?? '';
  if (token.length < 32 || /\s|[^\x21-\x7e]/u.test(token)) throw new Error('MCP_TOKEN: нужно не менее 32 печатных ASCII-символов без пробелов.');
  const indexPath = path.resolve(env.INDEX_DIR ?? './data');
  if (inside(docsRoot, indexPath)) throw new Error('INDEX_DIR не должен находиться внутри DOCS_ROOT.');
  let ancestor = indexPath;
  let canonicalAncestor: string | undefined;
  while (!canonicalAncestor) {
    canonicalAncestor = await realpath(ancestor).catch(() => undefined);
    if (!canonicalAncestor) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('INDEX_DIR: родительская папка должна быть доступной.');
      ancestor = parent;
    }
  }
  if (inside(docsRoot, path.resolve(canonicalAncestor, path.relative(ancestor, indexPath)))) throw new Error('INDEX_DIR не должен ссылаться внутрь DOCS_ROOT.');
  await mkdir(indexPath, { recursive: true, mode: 0o700 });
  const indexDir = await realpath(indexPath);
  if (inside(docsRoot, indexDir)) throw new Error('INDEX_DIR не должен ссылаться внутрь DOCS_ROOT.');
  const ocrLangs = (env.OCR_LANGS ?? 'rus+bel+eng').split('+');
  if (!ocrLangs.length || ocrLangs.some((lang) => !['rus', 'bel', 'eng'].includes(lang))) throw new Error('OCR_LANGS: доступны только rus, bel и eng, через +');
  const tunnelToken = env.TUNNEL_TOKEN ?? '';
  if (/[\s\0]/u.test(tunnelToken)) throw new Error('TUNNEL_TOKEN содержит недопустимые символы.');
  const host = tunnelToken ? '127.0.0.1' : env.HOST ?? '127.0.0.1';
  if (!host || /[\s/\0]/u.test(host)) throw new Error('HOST: укажите корректный адрес или имя сервера.');
  return {
    docsRoot, indexDir, token, host, ocrLangs: [...new Set(ocrLangs)], tunnelToken, publicUrl: normalizePublicUrl(env.PUBLIC_URL ?? ''), readOnly: env.READ_ONLY === '1',
    port: numberSetting(env, 'PORT', 3000, 65535),
    rescanMinutes: numberSetting(env, 'RESCAN_MINUTES', 10, 525600, false),
    maxFileBytes: numberSetting(env, 'MAX_FILE_MB', 100, 1024, false) * 1024 * 1024,
    ocrMaxPages: numberSetting(env, 'OCR_MAX_PAGES', 300, 10000),
    ignore: (env.IGNORE ?? '').split(',').map((pattern) => pattern.trim()).filter(Boolean),
  };
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
