import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inside, type Config } from './config.js';
import type { PathGuard } from './paths.js';

export const BROWSE_PAGE_SIZE = 200;
export const BROWSE_MAX_BYTES = 30 * 1024 * 1024;
export const BROWSE_MAX_PATH = 4096;
export const BROWSE_MAX_OFFSET = 1_000_000_000;

export type BrowseCode = 'file_missing' | 'file_changed' | 'file_too_large' | 'invalid_request' | 'unavailable';
export interface BrowseEntry { name: string; path: string; kind: 'directory' | 'file'; size: number | null; version: string | null }
export interface BrowseListing { path: string; entries: BrowseEntry[]; nextOffset: number | null }

export const BROWSE_MESSAGES = {
  file_missing: 'Файл или папка не найдены.',
  file_changed: 'Файл изменился. Обновите список и повторите.',
  file_too_large: 'Файл слишком большой для просмотра.',
  invalid_request: 'Некорректный запрос.',
  unavailable: 'Сервис временно недоступен. Повторите позже.',
} as const satisfies Record<BrowseCode, string>;

const STATUS: Record<BrowseCode, number> = { file_missing: 404, file_changed: 409, file_too_large: 413, invalid_request: 400, unavailable: 503 };

export class BrowseError extends Error {
  readonly status: number;
  constructor(readonly code: BrowseCode, message: string = BROWSE_MESSAGES[code], status = STATUS[code]) {
    super(message);
    this.status = status;
  }
}

export function fileVersion(info: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>): string {
  return createHash('sha256').update(`documents-mcp-file-v1\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}`).digest('hex');
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const collator = new Intl.Collator('ru', { numeric: true });

export class Browser {
  readonly maxBytes: number;
  constructor(private readonly guard: PathGuard, config: Pick<Config, 'maxFileBytes'>) {
    this.maxBytes = Math.min(BROWSE_MAX_BYTES, config.maxFileBytes);
  }

  private async locate(input: string): Promise<{ relative: string; absolute: string; info: Stats }> {
    let relative: string;
    try { relative = this.guard.normalize(input); } catch { throw new BrowseError('file_missing'); }
    if (relative && this.guard.ignored(relative)) throw new BrowseError('file_missing');
    try {
      let absolute = this.guard.root;
      let info = await lstat(absolute);
      const segments = relative ? relative.split('/') : [];
      for (const segment of segments) {
        if (!info.isDirectory()) throw new BrowseError('file_missing');
        absolute = path.join(absolute, segment);
        info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new BrowseError('file_missing');
      }
      const canonical = await realpath(absolute);
      if (!inside(this.guard.root, canonical)) throw new BrowseError('file_missing');
      const canonicalRelative = path.relative(this.guard.root, canonical).split(path.sep).join('/');
      if (canonicalRelative && this.guard.ignored(canonicalRelative)) throw new BrowseError('file_missing');
      return { relative, absolute, info };
    } catch { throw new BrowseError('file_missing'); }
  }

  async list(input: string, offset: number): Promise<BrowseListing> {
    const folder = await this.locate(input);
    if (!folder.info.isDirectory()) throw new BrowseError('file_missing');
    let names: string[];
    try { names = await readdir(folder.absolute); } catch { throw new BrowseError('file_missing'); }
    const entries: BrowseEntry[] = [];
    for (const name of names) {
      const relative = folder.relative ? `${folder.relative}/${name}` : name;
      if (name.includes('/') || name.includes('\\') || this.guard.ignored(relative)) continue;
      let info: Stats;
      try { info = await lstat(path.join(folder.absolute, name)); } catch { continue; }
      if (info.isDirectory()) entries.push({ name, path: relative, kind: 'directory', size: null, version: null });
      else if (info.isFile()) entries.push({ name, path: relative, kind: 'file', size: info.size, version: fileVersion(info) });
    }
    const after = await this.locate(input);
    if (!after.info.isDirectory() || !sameFile(after.info, folder.info)) throw new BrowseError('file_missing');
    entries.sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory') || collator.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const end = offset + BROWSE_PAGE_SIZE;
    return { path: folder.relative, entries: entries.slice(offset, end), nextOffset: end < entries.length ? end : null };
  }

  async read(input: string, version: string): Promise<Buffer> {
    const file = await this.locate(input);
    if (!file.info.isFile()) throw new BrowseError('file_missing');
    if (fileVersion(file.info) !== version) throw new BrowseError('file_changed');
    if (file.info.size > this.maxBytes) throw new BrowseError('file_too_large');
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(file.absolute, flags).catch(() => { throw new BrowseError('file_changed'); });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(opened, file.info) || fileVersion(opened) !== version) throw new BrowseError('file_changed');
      const current = await this.locate(input).catch(() => { throw new BrowseError('file_changed'); });
      if (!current.info.isFile() || !sameFile(current.info, opened)) throw new BrowseError('file_changed');
      const buffer = Buffer.allocUnsafe(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const closing = await handle.stat();
      if (length !== opened.size || fileVersion(closing) !== version) throw new BrowseError('file_changed');
      return buffer.subarray(0, length);
    } catch (error) {
      throw error instanceof BrowseError ? error : new BrowseError('file_changed');
    } finally { await handle.close().catch(() => {}); }
  }
}

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw new BrowseError('invalid_request');
  return values[0];
}

export function browseQuery(url: string, route: '/browse/files' | '/browse/file'): { path: string; offset: number; version: string } {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  let params: URLSearchParams;
  try { params = new URLSearchParams(query); } catch { throw new BrowseError('invalid_request'); }
  const allowed = route === '/browse/files' ? ['path', 'offset'] : ['path', 'version'];
  for (const key of params.keys()) if (!allowed.includes(key)) throw new BrowseError('invalid_request');
  const relative = single(params, 'path');
  if (relative !== undefined && relative.length > BROWSE_MAX_PATH) throw new BrowseError('invalid_request');
  if (route === '/browse/files') {
    const offset = single(params, 'offset') ?? '0';
    if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(offset) || Number(offset) > BROWSE_MAX_OFFSET) throw new BrowseError('invalid_request');
    return { path: relative ?? '', offset: Number(offset), version: '' };
  }
  const version = single(params, 'version');
  if (relative === undefined || version === undefined || !/^[0-9a-f]{64}$/u.test(version)) throw new BrowseError('invalid_request');
  return { path: relative, offset: 0, version };
}
