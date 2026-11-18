import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfigFile, serializeConfig } from './config.js';
import { whileBusy } from './install.js';
import { execute, requireAdministrator, restrictWindows, serviceAction, windowsTask, type InstallPaths } from './service.js';
import { newer, signedManifest, updateKey, UpdateError, verifyUpdateFile, type UpdateErrorCode } from './update-manifest.js';
import { atomicCopy, atomicWrite, readJson, saveUpdate, updateLock, updatePaths, type UpdateRecord } from './update-storage.js';
import { VERSION } from './version.js';
import { downloadDefaults } from './update-download.js';

export const UPDATE_TASK = 'documents-mcp-update';
export async function removeUpdateTask(): Promise<void> { await execute('schtasks.exe', ['/Delete', '/TN', UPDATE_TASK, '/F'], { windowsHide: true, timeout: 30_000 }); }
export async function updateTaskExists(): Promise<boolean> {
  try { await execute('schtasks.exe', ['/Query', '/TN', UPDATE_TASK], { windowsHide: true, timeout: 10_000 }); return true; } catch { return false; }
}
export async function scheduleUpdate(paths: InstallPaths): Promise<void> {
  const files = updatePaths(paths);
  await restrictWindows(files.directory);
  await writeFile(files.task, Buffer.from(`\ufeff${windowsTask({ ...paths, binary: files.candidate }, { arguments: 'apply-update', update: true })}`, 'utf16le'), { mode: 0o600 });
  await execute('schtasks.exe', ['/Create', '/TN', UPDATE_TASK, '/XML', files.task, '/F'], { windowsHide: true, timeout: 30_000 });
  await execute('schtasks.exe', ['/Run', '/TN', UPDATE_TASK], { windowsHide: true, timeout: 30_000 });
}
interface HealthDependencies { fetch: typeof fetch; now(): number; sleep(milliseconds: number): Promise<unknown>; alive(pid: number): void; timeoutMs: number }
async function healthText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) return Buffer.concat(chunks).toString('utf8'); size += chunk.value.length; if (size > limit) throw new UpdateError('health'); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
}
export async function versionHealth(settings: NodeJS.ProcessEnv, version: string, paths: InstallPaths, overrides: Partial<HealthDependencies> = {}): Promise<boolean> {
  const dependencies: HealthDependencies = { fetch, now: Date.now, sleep: delay, alive: (pid) => { process.kill(pid, 0); }, timeoutMs: 60_000, ...overrides };
  const port = settings.PORT ?? '3000';
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535 || !settings.MCP_TOKEN) return false;
  const base = `http://127.0.0.1:${port}`; const end = dependencies.now() + dependencies.timeoutMs;
  do {
    try {
      const health = await dependencies.fetch(`${base}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      const healthy = health.ok && (await healthText(health, 64)).trim() === 'ok';
      if (!health.ok) await health.body?.cancel();
      if (healthy) {
        const response = await dependencies.fetch(`${base}/control/status`, { headers: { Authorization: `Bearer ${settings.MCP_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
        if (response.ok && (JSON.parse(await healthText(response, 4 * 1024 * 1024)) as { version?: unknown }).version === version) {
          const running = await readJson<{ version: string; pid: number }>(updatePaths(paths).running);
          if (running?.version === version && Number.isSafeInteger(running.pid) && running.pid > 0) { dependencies.alive(running.pid); return true; }
        }
        await response.body?.cancel().catch(() => {});
      }
    } catch {}
    await dependencies.sleep(500);
  } while (dependencies.now() < end);
  return false;
}
export interface ApplyDependencies {
  platform: NodeJS.Platform; key: ReturnType<typeof updateKey>; version: string; executable: string;
  administrator(): Promise<void>; service: typeof serviceAction;
  swap(source: string, destination: string): Promise<unknown>;
  health: typeof versionHealth; removeTask(): Promise<void>;
  freeSpace(directory: string): Promise<number>;
}
async function replaceBusy(source: string, destination: string, paths: InstallPaths): Promise<void> {
  await whileBusy(() => rename(source, destination), () => execute('taskkill.exe', ['/F', '/T', '/IM', path.win32.basename(paths.binary)], { windowsHide: true, timeout: 10_000 }).catch(() => {}));
}
export async function cleanUpdateFiles(paths: InstallPaths): Promise<boolean> {
  const files = updatePaths(paths);
  let cleaned = true;
  for (const file of [files.partial, files.candidate, files.task, files.configBackup, files.staged, files.replaced, files.replaced + '.failed', files.manifest, files.signature]) await rm(file, { force: true }).catch(() => { cleaned = false; });
  return cleaned;
}

export async function applyUpdate(paths: InstallPaths, overrides: Partial<ApplyDependencies> = {}): Promise<void> {
  const dependencies: ApplyDependencies = { platform: process.platform, key: updateKey(), version: VERSION, executable: process.execPath, administrator: requireAdministrator, service: serviceAction, swap: (source, destination) => replaceBusy(source, destination, paths), health: versionHealth, removeTask: removeUpdateTask, freeSpace: downloadDefaults.freeSpace, ...overrides };
  if (dependencies.platform !== 'win32') throw new UpdateError('unsupported');
  await dependencies.administrator();
  const files = updatePaths(paths);
  if (path.resolve(dependencies.executable) !== path.resolve(files.candidate)) throw new UpdateError('install');
  let unlock: (() => void) | undefined;
  for (let attempt = 0; attempt < 60 && !unlock; attempt++) { unlock = await updateLock(files.lock); if (!unlock) await delay(500); }
  if (!unlock) throw new UpdateError('install');
  let record: UpdateRecord | undefined; let backedUp = false; let completed = false; let rollbackFailed = false;
  try {
    record = await readJson<UpdateRecord>(files.state);
    if (!record || record.state !== 'installing' && !(record.state === 'failed' && record.phase)) throw new UpdateError('install');
    backedUp = record.phase === 'backed_up' || record.phase === 'swapped';
    const manifest = signedManifest(await readFile(files.manifest), await readFile(files.signature, 'utf8'), dependencies.key);
    if (manifest.version !== dependencies.version || manifest.version !== record.target || !newer(manifest.version, record.from)) throw new UpdateError('not_newer');
    await verifyUpdateFile(dependencies.executable, manifest);
    record.state = 'installing'; record.error = null; await saveUpdate(paths, record);
    if (backedUp) throw new UpdateError('interrupted');
    const settings = await readConfigFile(paths.config);
    if (settings.REMOTE_UPDATE !== '1') throw new UpdateError('disabled');
    if (settings.INSTALLED_VERSION !== record.from) throw new UpdateError('install');
    if (await dependencies.freeSpace(path.dirname(paths.binary)) < manifest.assets['win-x64'].size + (await stat(paths.binary)).size * 2 + 64 * 1024 * 1024) throw new UpdateError('disk');
    await atomicWrite(files.configBackup, await readFile(paths.config));
    await atomicCopy(paths.binary, files.previous);
    await atomicCopy(files.candidate, files.staged);
    await verifyUpdateFile(files.staged, manifest);
    record.phase = 'backed_up'; await saveUpdate(paths, record); backedUp = true;
    await dependencies.service('stop', paths);
    await rm(files.replaced, { force: true });
    await dependencies.swap(paths.binary, files.replaced);
    await dependencies.swap(files.staged, paths.binary);
    record.phase = 'swapped'; await saveUpdate(paths, record);
    await atomicWrite(paths.config, serializeConfig({ ...settings, INSTALLED_VERSION: manifest.version }));
    await rm(files.running, { force: true });
    await dependencies.service('start', paths);
    if (!await dependencies.health(settings, manifest.version, paths)) throw new UpdateError('health');
    await saveUpdate(paths, { ...record, state: 'idle', error: null, phase: undefined, cleanup: true });
    completed = true;
  } catch (error) {
    let code: UpdateErrorCode = error instanceof UpdateError ? error.code : 'install';
    if (backedUp) {
      try {
        await dependencies.service('stop', paths).catch(() => {});
        await copyFile(files.previous, files.staged);
        await rm(files.replaced + '.failed', { force: true });
        if (await stat(paths.binary).then(() => true, () => false)) await dependencies.swap(paths.binary, files.replaced + '.failed');
        await dependencies.swap(files.staged, paths.binary);
        await atomicWrite(paths.config, await readFile(files.configBackup));
        await dependencies.service('start', paths);
        await rm(files.replaced + '.failed', { force: true });
      } catch { code = 'install'; rollbackFailed = true; }
    }
    if (record) await saveUpdate(paths, { ...record, state: 'failed', error: code, phase: rollbackFailed ? record.phase : undefined, cleanup: !rollbackFailed });
    completed = Boolean(record) && !rollbackFailed;
  } finally {
    if (completed) {
      await dependencies.removeTask().catch(() => {});
      await cleanUpdateFiles(paths);
    }
    unlock();
  }
  if (rollbackFailed) throw new UpdateError('install');
}
