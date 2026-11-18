import { open, readFile, rm, stat, statfs } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { KeyObject } from 'node:crypto';
import { atomicWrite, updatePaths } from './update-storage.js';
import { MAX_UPDATE_SIZE, newer, signedManifest, UPDATE_ASSET, UPDATE_ORIGIN, UpdateError, type UpdateManifest } from './update-manifest.js';
import type { InstallPaths } from './service.js';

export interface DownloadDependencies {
  fetch: typeof fetch; key: KeyObject; current: string;
  sleep(milliseconds: number): Promise<unknown>; now(): number;
  freeSpace(directory: string): Promise<number>;
  signal: AbortSignal;
}
export const downloadDefaults = {
  fetch: globalThis.fetch, sleep: (milliseconds: number) => delay(milliseconds, undefined, { ref: false }), now: Date.now,
  freeSpace: async (directory: string) => { const info = await statfs(directory, { bigint: true }); return Number(info.bavail * info.bsize); },
};
export function allowedUpdateUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'));
}
export async function releaseResponse(asset: string, dependencies: DownloadDependencies, headers: Record<string, string> = {}): Promise<Response> {
  let url = new URL(asset, UPDATE_ORIGIN);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!allowedUpdateUrl(url)) throw new UpdateError('network');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let response: Response;
      try { response = await dependencies.fetch(url, { redirect: 'manual', headers: { 'Accept-Encoding': 'identity', ...headers }, signal: AbortSignal.any([dependencies.signal, controller.signal]) }); }
      finally { clearTimeout(timer); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location'); if (!location) throw new UpdateError('network');
        url = new URL(location, url); continue;
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          const idle = setTimeout(() => controller.abort(), 60_000);
          try { const chunk = await reader.read(); if (chunk.done) output.close(); else output.enqueue(chunk.value); }
          catch (error) { output.error(error); }
          finally { clearTimeout(idle); }
        },
        async cancel() { controller.abort(); await reader.cancel().catch(() => {}); },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
  } catch (error) { if (error instanceof UpdateError) throw error; }
  throw new UpdateError('network');
}
async function limitedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new UpdateError('network'); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > limit) throw new UpdateError('signature'); chunks.push(result.value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
export async function fetchManifest(dependencies: DownloadDependencies) {
  try {
    const bytes = await limitedBody(await releaseResponse('update-manifest.json', dependencies), 16_384);
    const signature = (await limitedBody(await releaseResponse('update-manifest.json.sig', dependencies), 128)).toString('utf8');
    const manifest = signedManifest(bytes, signature, dependencies.key);
    return { bytes, signature, manifest };
  } catch (error) { if (error instanceof UpdateError) throw error; throw new UpdateError('network'); }
}

export async function downloadUpdate(paths: InstallPaths, dependencies: DownloadDependencies, progress: (manifest: UpdateManifest, received: number) => Promise<void>): Promise<UpdateManifest> {
  const files = updatePaths(paths);
  for (let attempt = 0; attempt < 8; attempt++) {
    dependencies.signal.throwIfAborted();
    try {
      const release = await fetchManifest(dependencies);
      if (!newer(release.manifest.version, dependencies.current)) throw new UpdateError('not_newer');
      const previous = await readFile(files.manifest).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!previous?.equals(release.bytes)) await rm(files.partial, { force: true });
      await atomicWrite(files.manifest, release.bytes); await atomicWrite(files.signature, release.signature);
      const asset = release.manifest.assets['win-x64'];
      let received = await stat(files.partial).then((entry) => entry.size, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
      if (received > asset.size) { await rm(files.partial); received = 0; }
      const installedSize = await stat(paths.binary).then((entry) => entry.size, () => MAX_UPDATE_SIZE);
      if (await dependencies.freeSpace(files.directory) < (asset.size - received) + asset.size * 2 + installedSize * 2 + 64 * 1024 * 1024) throw new UpdateError('disk');
      await progress(release.manifest, received);
      if (received === asset.size) return release.manifest;
      const response = await releaseResponse(UPDATE_ASSET, dependencies, received ? { Range: `bytes=${received}-` } : {});
      if (response.status === 200) received = 0;
      else if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== received || Number(range[2]) !== asset.size - 1 || Number(range[3]) !== asset.size) { await response.body?.cancel(); throw new UpdateError('integrity'); }
      } else { await response.body?.cancel(); throw new UpdateError('network'); }
      if (!response.body || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response.body?.cancel(); throw new UpdateError('integrity'); }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) !== asset.size - received)) { await response.body.cancel(); throw new UpdateError('integrity'); }
      const handle = await open(files.partial, received ? 'r+' : 'w', 0o600);
      const reader = response.body.getReader(); let reported = dependencies.now();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          if (received + chunk.value.length > asset.size) throw new UpdateError('integrity');
          let offset = 0;
          while (offset < chunk.value.length) { const written = await handle.write(chunk.value, offset, chunk.value.length - offset, received); if (!written.bytesWritten) throw new UpdateError('disk'); received += written.bytesWritten; offset += written.bytesWritten; }
          if (dependencies.now() - reported >= 1000) { await progress(release.manifest, received); reported = dependencies.now(); }
        }
        await handle.sync();
      } finally { await handle.close(); await reader.cancel().catch(() => {}); }
      await progress(release.manifest, received);
      if (received !== asset.size) throw new UpdateError('network');
      return release.manifest;
    } catch (error) {
      dependencies.signal.throwIfAborted();
      const code = error instanceof UpdateError ? error.code : ['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EDQUOT', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'disk' : 'network';
      if (code !== 'network' || attempt === 7) throw new UpdateError(code);
      let onAbort: () => void = () => {};
      try {
        await Promise.race([dependencies.sleep(Math.min(60_000, 1000 * 2 ** attempt)), new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(dependencies.signal.reason); dependencies.signal.addEventListener('abort', onAbort, { once: true });
          if (dependencies.signal.aborted) onAbort();
        })]);
      } finally { dependencies.signal.removeEventListener('abort', onAbort); }
    }
  }
  throw new UpdateError('network');
}
