import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { InstallPaths } from './service.js';
import type { UpdateErrorCode } from './update-manifest.js';

export interface UpdateState {
  state: 'idle' | 'checking' | 'downloading' | 'verifying' | 'installing' | 'failed';
  target: string | null; received: number; size: number | null; error: UpdateErrorCode | null;
}
export interface UpdateRecord extends UpdateState { from: string; phase?: 'prepared' | 'backed_up' | 'swapped'; cleanup?: boolean }
export const idleUpdate = (): UpdateState => ({ state: 'idle', target: null, received: 0, size: null, error: null });
export function updatePaths(paths: InstallPaths) {
  const directory = path.join(paths.data, 'update');
  return { directory, state: path.join(directory, 'state.json'), running: path.join(directory, 'running.json'), cache: path.join(directory, 'available.json'), lock: path.join(directory, 'lock.sqlite'), checkLock: path.join(directory, 'check.sqlite'), manifest: path.join(directory, 'update-manifest.json'), signature: path.join(directory, 'update-manifest.json.sig'), partial: path.join(directory, 'download.part'), candidate: path.join(directory, 'candidate.exe'), task: path.join(directory, 'apply-task.xml'), configBackup: path.join(directory, 'config.previous'), previous: `${paths.binary}.previous`, staged: `${paths.binary}.update`, replaced: `${paths.binary}.replaced` };
}
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export async function readJson<Type>(file: string): Promise<Type | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Type; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function atomicCopy(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
export async function saveUpdate(paths: InstallPaths, state: UpdateRecord): Promise<void> { await atomicWrite(updatePaths(paths).state, JSON.stringify(state)); }
export async function updateLock(file: string): Promise<(() => void) | undefined> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  try { database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch (error) { database.close(); if (String((error as Error).message).includes('locked')) return undefined; throw error; }
  let released = false;
  return () => { if (!released) { released = true; database.close(); } };
}
