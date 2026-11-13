import { constants, type Stats } from 'node:fs';
import { realpath, stat, lstat, open, readdir, mkdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { inside } from './config.js';
import { NOT_FOUND, UserError } from './types.js';

export class PathGuard {
  private readonly matches: (value: string) => boolean;
  constructor(readonly root: string, patterns: string[] = []) {
    this.matches = picomatch(patterns, { dot: true, nocase: true });
  }

  normalize(input: string): string {
    if (input.includes('\0') || input.includes('\\') || path.posix.isAbsolute(input) || /^[a-z]:/iu.test(input)) throw new UserError(NOT_FOUND);
    const segments = input.split('/');
    if (segments.some((segment) => segment === '..')) throw new UserError(NOT_FOUND);
    return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  }

  ignored(relative: string): boolean {
    const segments = relative.split('/');
    return segments.some((segment, index) => segment.startsWith('.') || segment.startsWith('~$') || ['thumbs.db', 'desktop.ini', 'node_modules'].includes(segment.toLowerCase()) || this.matches(segments.slice(0, index + 1).join('/')) || this.matches(`${segments.slice(0, index + 1).join('/')}/`));
  }

  validateWritable(input: string): string {
    const relative = this.normalize(input);
    if (!relative || input.length > 1000 || this.ignored(relative)) throw new UserError('Недопустимый или исключённый путь. Корень изменять нельзя.');
    const segments = relative.split('/');
    for (const segment of segments) {
      if (/[<>:"|?*\x00-\x1f\x7f]/u.test(segment) || /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment) || Buffer.byteLength(segment) > 255) {
        throw new UserError('Недопустимое имя: запрещены специальные символы Windows, служебные имена, конечные точки и пробелы; максимум 255 байт.');
      }
    }
    return relative;
  }

  async writable(input: string, allowMissing = false) {
    const relative = this.validateWritable(input);
    const segments = relative.split('/');
    let absolute = this.root;
    let info: Stats | undefined;
    for (const [index, segment] of segments.entries()) {
      absolute = path.join(absolute, segment);
      try { info = await lstat(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw new UserError(NOT_FOUND);
        info = undefined;
        continue;
      }
      if (info.isSymbolicLink()) throw new UserError('Изменение через символические ссылки запрещено.');
      if (!inside(this.root, await realpath(absolute))) throw new UserError(NOT_FOUND);
      if (index < segments.length - 1 && !info.isDirectory()) throw new UserError('Родительский путь не является папкой.');
    }
    return { relative, absolute, info };
  }

  async writableTree(input: string, destination?: string): Promise<number> {
    const target = await this.writable(input);
    if (destination) this.validateWritable(destination);
    if (target.info!.isFile()) return target.info!.size;
    if (!target.info!.isDirectory()) throw new UserError('Поддерживаются только обычные файлы и папки.');
    let size = 0;
    for (const name of await readdir(target.absolute)) size += await this.writableTree(`${target.relative}/${name}`, destination ? `${destination}/${name}` : undefined);
    return size;
  }

  async createFolders(input: string): Promise<void> {
    const target = await this.writable(input, true);
    const segments = target.relative.split('/');
    for (let count = 1; count <= segments.length; count++) {
      const current = await this.writable(segments.slice(0, count).join('/'), true);
      if (current.info && !current.info.isDirectory()) throw new UserError('По этому пути уже существует файл.');
      if (!current.info) await mkdir(current.absolute, { mode: 0o755 });
      await this.writable(segments.slice(0, count).join('/'));
    }
  }

  async resolve(input: string, kind?: 'file' | 'directory') {
    try {
      const relative = this.normalize(input);
      if (relative && this.ignored(relative)) throw new UserError(NOT_FOUND);
      const absolute = await realpath(path.join(this.root, relative));
      if (!inside(this.root, absolute)) throw new UserError(NOT_FOUND);
      const canonicalRelative = path.relative(this.root, absolute).split(path.sep).join('/');
      if (canonicalRelative && this.ignored(canonicalRelative)) throw new UserError(NOT_FOUND);
      const info = await stat(absolute);
      if (kind === 'file' && !info.isFile() || kind === 'directory' && !info.isDirectory()) throw new UserError(NOT_FOUND);
      return { relative, absolute, info };
    } catch { throw new UserError(NOT_FOUND); }
  }

  async openFile(input: string): Promise<{ handle: FileHandle; relative: string; info: Awaited<ReturnType<typeof stat>> }> {
    const resolved = await this.resolve(input, 'file');
    const handle = await open(resolved.absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new UserError(NOT_FOUND); });
    try {
      const current = await this.resolve(input, 'file');
      const info = await handle.stat();
      if (info.dev !== current.info.dev || info.ino !== current.info.ino || current.absolute !== resolved.absolute) throw new UserError(NOT_FOUND);
      return { handle, relative: resolved.relative, info };
    } catch { await handle.close(); throw new UserError(NOT_FOUND); }
  }

  async *walk(relative = '', ancestors = new Set<string>()): AsyncGenerator<string> {
    const directory = await this.resolve(relative, 'directory');
    if (ancestors.has(directory.absolute)) return;
    const nextAncestors = new Set([...ancestors, directory.absolute]);
    const entries = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (this.ignored(child)) continue;
      let target;
      try { target = await this.resolve(child); } catch { continue; }
      if (target.info.isDirectory()) yield* this.walk(child, nextAncestors);
      else if (target.info.isFile()) yield child;
    }
  }
}
