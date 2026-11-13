import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAsset, isSea } from 'node:sea';
import { VERSION } from './version.js';

export interface AssetEntry { sha256: string; executable?: boolean }
export interface AssetManifest { files: Record<string, AssetEntry> }
export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export async function extractAssets(indexDir: string, manifest: AssetManifest, read: (name: string) => Promise<Uint8Array>): Promise<string> {
  const parent = path.join(indexDir, 'runtime');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) throw new Error('Каталог runtime не должен быть символической ссылкой.');
  await chmod(parent, 0o700);
  const directory = path.join(parent, `${VERSION}-${sha256(JSON.stringify(manifest)).slice(0, 20)}`);
  const validate = async (): Promise<boolean> => {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      await chmod(directory, 0o700);
      const checked = new Set<string>();
      for (const [name, entry] of Object.entries(manifest.files)) {
        const file = path.join(directory, name);
        let parent = path.dirname(file);
        while (parent !== directory && !checked.has(parent)) {
          const info = await lstat(parent);
          if (!info.isDirectory() || info.isSymbolicLink()) return false;
          await chmod(parent, 0o700);
          checked.add(parent); parent = path.dirname(parent);
        }
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || sha256(await readFile(file)) !== entry.sha256) return false;
        await chmod(file, entry.executable ? 0o700 : 0o600);
      }
      return true;
    } catch { return false; }
  };
  for (const name of Object.keys(manifest.files)) {
    if (!name || path.posix.isAbsolute(name) || /[\\:\0]/u.test(name) || name.split('/').some((part) => !part || part === '..' || part === '.')) throw new Error('Небезопасное имя встроенного файла.');
  }
  if (!await validate()) {
    const staging = `${directory}.tmp-${randomBytes(8).toString('hex')}`;
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const [name, entry] of Object.entries(manifest.files)) {
        const bytes = await read(name);
        if (sha256(bytes) !== entry.sha256) throw new Error('Контрольная сумма встроенного файла не совпадает.');
        const file = path.join(staging, name);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, bytes, { mode: entry.executable ? 0o700 : 0o600, flag: 'wx' });
      }
      await rm(directory, { recursive: true, force: true });
      await rename(staging, directory);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  for (const name of await readdir(parent)) {
    if (/^\d+\.\d+\.\d+-[a-f0-9]{20}(?:\.tmp-[a-f0-9]+)?$/u.test(name) && path.join(parent, name) !== directory) await rm(path.join(parent, name), { recursive: true, force: true });
  }
  return directory;
}

export async function prepareRuntime(indexDir: string): Promise<string> {
  if (isSea()) {
    const manifest = JSON.parse(getAsset('manifest.json', 'utf8')) as AssetManifest;
    return extractAssets(indexDir, manifest, async (name) => new Uint8Array(getAsset(name)));
  }
  const source = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../dist/runtime/' : './runtime/', import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8')) as AssetManifest;
  return extractAssets(indexDir, manifest, async (name) => readFile(path.join(source, name)));
}
