import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultPaths, inside } from './config.js';
import { restrictWindows, type InstallPaths } from './service.js';
import { cleanUpdateFiles, removeUpdateTask, scheduleUpdate, updateTaskExists } from './update-apply.js';
import { downloadDefaults, downloadUpdate, fetchManifest, type DownloadDependencies } from './update-download.js';
import { newer, updateKey, UpdateError, verifyUpdateFile } from './update-manifest.js';
import { atomicWrite, idleUpdate, readJson, saveUpdate, updateLock, updatePaths, type UpdateRecord, type UpdateState } from './update-storage.js';
import { VERSION } from './version.js';

export interface UpdateStatus extends UpdateState { supported: boolean; allowed: boolean; current: string; available: string | null }
interface Availability { checkedAt: number; available: string | null }
export interface UpdateDependencies extends Omit<DownloadDependencies, 'signal'> {
  platform: NodeJS.Platform; arch: string; paths: InstallPaths;
  protect(directory: string): Promise<void>; schedule(paths: InstallPaths): Promise<void>;
  taskExists(): Promise<boolean>; removeTask(): Promise<void>;
  docsRoot?: string; indexDir?: string;
}
export class RemoteUpdate {
  private readonly dependencies: UpdateDependencies;
  private readonly abort = new AbortController();
  private active?: Promise<void>;
  private checking?: Promise<void>;
  private maintenance?: NodeJS.Timeout;
  private fallback = idleUpdate();
  private ready = false;
  constructor(private readonly allowed: boolean, overrides: Partial<UpdateDependencies> = {}) {
    this.dependencies = { ...downloadDefaults, current: VERSION, key: updateKey(), platform: process.platform, arch: process.arch, paths: defaultPaths(), protect: restrictWindows, schedule: scheduleUpdate, taskExists: updateTaskExists, removeTask: removeUpdateTask, ...overrides };
  }
  get supported(): boolean { return this.dependencies.platform === 'win32' && this.dependencies.arch === 'x64'; }
  async initialize(): Promise<void> {
    if (!this.supported || this.ready) return;
    try {
      const { paths } = this.dependencies; const files = updatePaths(paths);
      const data = await realpath(paths.data); const binaryDirectory = await realpath(path.dirname(paths.binary));
      if (this.dependencies.docsRoot && (inside(this.dependencies.docsRoot, data) || inside(this.dependencies.docsRoot, binaryDirectory))) throw new UpdateError('disk');
      if (this.dependencies.indexDir && this.dependencies.indexDir !== paths.data && inside(this.dependencies.indexDir, files.directory)) throw new UpdateError('disk');
      if (!(await lstat(paths.data)).isDirectory()) throw new UpdateError('disk');
      await mkdir(files.directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(files.directory)).isDirectory()) throw new UpdateError('disk');
      await this.dependencies.protect(files.directory);
      this.ready = true;
      const unlock = await updateLock(files.lock);
      if (unlock) {
        try {
          const record = await readJson<UpdateRecord>(files.state);
          if (record && !['idle', 'failed'].includes(record.state)) {
            const pendingTask = record.state === 'installing' && await this.dependencies.taskExists();
            await saveUpdate(paths, { ...record, state: 'failed', error: 'interrupted', phase: record.phase === 'prepared' && !pendingTask ? undefined : record.phase });
          }
        } finally { unlock(); }
      }
      this.maintenance = setInterval(() => { void this.cleanup().catch(() => {}); }, 5000); this.maintenance.unref();
      await this.cleanup();
    } catch { this.ready = false; this.fallback = { ...idleUpdate(), state: 'failed', error: 'disk' }; }
  }
  private async cleanup(): Promise<void> {
    const { paths } = this.dependencies; const files = updatePaths(paths);
    if (!(await readJson<UpdateRecord>(files.state))?.cleanup) return;
    const unlock = await updateLock(files.lock); if (!unlock) return;
    try {
      const record = await readJson<UpdateRecord>(files.state);
      if (record?.cleanup && !record.phase && ['idle', 'failed'].includes(record.state)) {
        if (await this.dependencies.taskExists()) await this.dependencies.removeTask();
        if (await cleanUpdateFiles(paths) && !await this.dependencies.taskExists()) await saveUpdate(paths, { ...record, cleanup: false });
      }
    } finally { unlock(); }
  }
  async status(refresh = true): Promise<UpdateStatus> {
    const { paths, current } = this.dependencies; const files = updatePaths(paths);
    let state: UpdateState = this.fallback; let available: string | null = null;
    if (this.ready) {
      try { state = await readJson<UpdateRecord>(files.state) ?? state; available = (await readJson<Availability>(files.cache))?.available ?? null; if (available && !newer(available, current)) available = null; }
      catch { state = { ...state, state: 'failed', error: 'disk' }; }
      if (refresh && !this.checking && !this.abort.signal.aborted) {
        this.checking = this.refresh().catch(() => {}).finally(() => { this.checking = undefined; });
      }
    }
    return { supported: this.supported, allowed: this.allowed, current, available, state: state.state, target: state.target, received: state.received, size: state.size, error: !this.supported ? 'unsupported' : !this.allowed ? 'disabled' : state.error };
  }
  private async refresh(): Promise<void> {
    const { paths } = this.dependencies; const files = updatePaths(paths);
    const unlock = await updateLock(files.checkLock); if (!unlock) return;
    try {
      const cached = await readJson<Availability>(files.cache);
      const now = this.dependencies.now();
      if (cached && now - cached.checkedAt < 3_600_000) return;
      await atomicWrite(files.cache, JSON.stringify({ checkedAt: now, available: null }));
      const { manifest } = await fetchManifest({ ...this.dependencies, signal: this.abort.signal });
      await atomicWrite(files.cache, JSON.stringify({ checkedAt: now, available: newer(manifest.version, this.dependencies.current) ? manifest.version : null }));
    } finally { unlock(); }
  }
  async start(): Promise<UpdateStatus> {
    if (!this.supported) throw new UpdateError('unsupported');
    if (!this.allowed) throw new UpdateError('disabled');
    if (!this.ready || this.abort.signal.aborted) throw new UpdateError('disk');
    const { paths, current } = this.dependencies; const files = updatePaths(paths);
    let unlock = await updateLock(files.lock);
    for (let attempt = 0; !unlock && attempt < 50; attempt++) {
      const status = await this.status(false);
      if (!['idle', 'failed'].includes(status.state)) return status;
      await delay(20); unlock = await updateLock(files.lock);
    }
    if (!unlock) throw new UpdateError('install');
    try {
      const previous = await readJson<UpdateRecord>(files.state);
      if (previous?.state === 'installing' || previous?.phase) { unlock(); return this.status(false); }
      const record: UpdateRecord = { ...idleUpdate(), state: 'checking', from: current };
      await saveUpdate(paths, record);
      this.active = this.run(record).finally(unlock);
      return this.status(false);
    } catch (error) { unlock(); throw error; }
  }
  private async run(record: UpdateRecord): Promise<void> {
    const { paths } = this.dependencies; const files = updatePaths(paths);
    try {
      const manifest = await downloadUpdate(paths, { ...this.dependencies, signal: this.abort.signal }, async (release, received) => {
        Object.assign(record, { state: 'downloading', target: release.version, received, size: release.assets['win-x64'].size }); await saveUpdate(paths, record);
      });
      record.state = 'verifying'; await saveUpdate(paths, record);
      await verifyUpdateFile(files.partial, manifest);
      await rm(files.candidate, { force: true }); await rename(files.partial, files.candidate);
      record.state = 'installing'; record.phase = 'prepared'; await saveUpdate(paths, record);
      await this.dependencies.schedule(paths);
    } catch (error) {
      const installing = record.state === 'installing';
      record.state = 'failed'; record.error = this.abort.signal.aborted ? 'interrupted' : error instanceof UpdateError ? error.code : installing ? 'install' : 'disk';
      record.phase = undefined;
      if (installing) await this.dependencies.removeTask().catch(() => {});
      if (record.error === 'integrity') { await rm(files.partial, { force: true }).catch(() => {}); await rm(files.candidate, { force: true }).catch(() => {}); }
      this.fallback = record;
      await saveUpdate(paths, record).catch(() => {});
    }
  }
  async close(): Promise<void> {
    clearInterval(this.maintenance); this.abort.abort();
    await Promise.allSettled([this.active, this.checking]);
  }
  async confirmRunning(): Promise<void> {
    if (this.ready) await atomicWrite(updatePaths(this.dependencies.paths).running, JSON.stringify({ version: this.dependencies.current, pid: process.pid })).catch(() => {});
  }
  async settled(): Promise<void> { await this.active; }
}
