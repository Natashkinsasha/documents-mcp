import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, readdir, readFile, writeFile, rename, rm, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { PathGuard } from './paths.js';
import { UserError } from './types.js';

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export type TrashReason = 'deleted' | 'replaced' | 'edited' | 'overwritten by move';
export interface TrashEntry { id: string; originalPath: string; kind: 'file' | 'folder'; size: number; reason: TrashReason; deletedAt: string }
const validId = (id: string) => /^\d{17}-[a-f0-9]{16}$/u.test(id);
export const expiresAt = (entry: TrashEntry) => new Date(Date.parse(entry.deletedAt) + RETENTION_MS).toISOString();

export class Trash {
  readonly directory: string;
  constructor(private readonly guard: PathGuard, private readonly now = Date.now) { this.directory = path.join(guard.root, '.documents-mcp-trash'); }

  private async root(create = false): Promise<boolean> {
    if (create) await mkdir(this.directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    let info;
    try { info = await lstat(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.directory) !== this.directory) throw new UserError('Корзина недоступна: небезопасный путь.');
    if (create && process.platform === 'win32') execFile('attrib', ['+h', this.directory], { windowsHide: true }, () => {});
    return true;
  }

  async get(id: string): Promise<TrashEntry> {
    if (!validId(id) || !await this.root()) throw new UserError('Запись корзины не найдена.');
    try {
      const directory = path.join(this.directory, id);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      if ((await lstat(path.join(directory, 'meta.json'))).isSymbolicLink()) throw new Error();
      const handle = await open(path.join(directory, 'meta.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let entry: TrashEntry;
      try { if ((await handle.stat()).size > 8192) throw new Error(); entry = JSON.parse(await handle.readFile('utf8')) as TrashEntry; }
      finally { await handle.close(); }
      if (entry.id !== id || typeof entry.originalPath !== 'string' || !['file', 'folder'].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !['deleted', 'replaced', 'edited', 'overwritten by move'].includes(entry.reason) || !Number.isFinite(Date.parse(entry.deletedAt))) throw new Error();
      return entry;
    } catch { throw new UserError('Запись корзины не найдена или повреждена.'); }
  }

  item(id: string): string {
    if (!validId(id)) throw new UserError('Некорректный идентификатор корзины.');
    return path.join(this.directory, id, 'item');
  }

  async put(input: string, reason: TrashReason, copy = false): Promise<TrashEntry> {
    const size = await this.guard.writableTree(input);
    const source = await this.guard.writable(input);
    await this.root(true);
    const deletedAt = new Date(this.now()).toISOString();
    const id = `${deletedAt.replace(/\D/gu, '')}-${randomBytes(8).toString('hex')}`;
    const entry: TrashEntry = { id, originalPath: source.relative, kind: source.info!.isDirectory() ? 'folder' : 'file', size, reason, deletedAt };
    const directory = path.join(this.directory, id);
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(path.join(directory, 'meta.json'), JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
      await this.guard.writable(input);
      if (copy) {
        const handle = await open(source.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const destination = await open(path.join(directory, 'copy.tmp'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(async (error: unknown) => { await handle.close(); throw error; });
        try {
          const info = await handle.stat();
          if (info.ino !== source.info!.ino || info.dev !== source.info!.dev) throw new UserError('Файл изменился во время резервного копирования.');
          const buffer = Buffer.alloc(64 * 1024);
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            let offset = 0;
            while (offset < bytesRead) {
              const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset);
              if (!bytesWritten) throw new UserError('Не удалось сохранить резервную копию.');
              offset += bytesWritten;
            }
          }
          await destination.chmod(source.info!.mode & 0o777);
          await destination.sync();
        }
        finally { await handle.close(); await destination.close(); }
        await rename(path.join(directory, 'copy.tmp'), this.item(id));
      } else await rename(source.absolute, this.item(id));
      return entry;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  async list(): Promise<TrashEntry[]> {
    if (!await this.root()) return [];
    const entries: TrashEntry[] = [];
    for (const id of await readdir(this.directory)) {
      if (!validId(id)) continue;
      try {
        const entry = await this.get(id);
        const item = await lstat(this.item(id));
        if (!item.isSymbolicLink() && (entry.kind === 'file' ? item.isFile() : item.isDirectory()) && Date.parse(entry.deletedAt) + RETENTION_MS > this.now()) entries.push(entry);
      } catch {}
    }
    return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || right.id.localeCompare(left.id)).slice(0, 200);
  }

  async purge(): Promise<void> {
    if (!await this.root()) return;
    for (const id of await readdir(this.directory)) {
      if (!validId(id)) continue;
      try { const entry = await this.get(id); if (Date.parse(entry.deletedAt) + RETENTION_MS <= this.now()) await this.remove(id); } catch {}
    }
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await rm(path.join(this.directory, id), { recursive: true, force: true });
  }

  async validateRestore(entry: TrashEntry, to: string): Promise<void> {
    if (Date.parse(entry.deletedAt) + RETENTION_MS <= this.now()) throw new UserError('Срок хранения истёк: прошло 30 дней.');
    const inspect = async (absolute: string, relative: string): Promise<void> => {
      this.guard.validateWritable(relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new UserError('Корзина содержит небезопасный путь.');
      if (info.isDirectory()) for (const name of await readdir(absolute)) await inspect(path.join(absolute, name), `${relative}/${name}`);
    };
    await inspect(this.item(entry.id), to);
  }

  async restoreItem(entry: TrashEntry, to: string): Promise<void> {
    await this.validateRestore(entry, to);
    const target = await this.guard.writable(to, true);
    if (target.info) throw new UserError('Путь восстановления уже существует.');
    await rename(this.item(entry.id), target.absolute);
    await this.remove(entry.id);
  }
}
