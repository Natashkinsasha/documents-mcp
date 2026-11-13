import { build } from 'esbuild';
import { inject } from 'postject';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntime, writeManifest, root, runtime } from './prepare-runtime.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
export const versions = JSON.parse(await readFile(new URL('./binary-versions.json', import.meta.url), 'utf8'));
const cache = path.join(root, '.cache');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function download(url, file, checksum) {
  await mkdir(path.dirname(file), { recursive: true });
  try { const bytes = await readFile(file); if (!checksum || digest(bytes) === checksum) return file; } catch {}
  console.log(`Загрузка ${path.basename(file)}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (checksum && digest(bytes) !== checksum) throw new Error(`SHA-256 mismatch: ${path.basename(file)}`);
  await writeFile(`${file}.part`, bytes); await rename(`${file}.part`, file);
  return file;
}

export async function cloudflared(target) {
  const asset = versions.cloudflared.assets[target];
  if (!asset) throw new Error(`Unsupported cloudflared target: ${target}`);
  const archive = await download(`https://github.com/cloudflare/cloudflared/releases/download/${versions.cloudflared.version}/${asset.name}`, path.join(cache, 'downloads', asset.name), asset.sha256);
  const destination = path.join(cache, `cloudflared-${versions.cloudflared.version}-${target}${target.startsWith('win-') ? '.exe' : ''}`);
  if (asset.name.endsWith('.tgz')) {
    const directory = path.join(cache, `cloudflared-${target}`); await mkdir(directory, { recursive: true });
    await execute('tar', ['-xzf', archive, '-C', directory]);
    await copyFile(path.join(directory, 'cloudflared'), destination);
  } else await copyFile(archive, destination);
  await chmod(destination, 0o755);
  return destination;
}

async function nodeBinary(target) {
  const version = `v${versions.node}`;
  const base = `https://nodejs.org/dist/${version}`;
  const checksumsFile = await download(`${base}/SHASUMS256.txt`, path.join(cache, 'downloads', `${version}-SHASUMS256.txt`));
  const checksums = new Map((await readFile(checksumsFile, 'utf8')).trim().split('\n').map((line) => { const [hash, name] = line.trim().split(/\s+/u); return [name, hash]; }));
  const name = target.startsWith('win-') ? `${target}/node.exe` : `node-${version}-${target}.tar.gz`;
  const checksum = checksums.get(name);
  if (!checksum) throw new Error(`Official checksum not found: ${name}`);
  const archive = await download(`${base}/${name}`, path.join(cache, 'downloads', `${version}-${name.replaceAll('/', '-')}`), checksum);
  if (target.startsWith('win-')) return archive;
  const directory = path.join(cache, `node-${version}-${target}`);
  await mkdir(directory, { recursive: true });
  await execute('tar', ['-xzf', archive, '--strip-components=1', '-C', directory]);
  return path.join(directory, 'bin/node');
}

async function main() {
  const argumentsList = process.argv.slice(2).filter((argument) => argument !== '--');
  const host = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  if (argumentsList.includes('--runtime-only')) {
    await prepareRuntime();
    await copyFile(await cloudflared(host), path.join(runtime, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'));
    await writeManifest(runtime, ['cloudflared', 'cloudflared.exe']); return;
  }
  const supported = Object.keys(versions.cloudflared.assets);
  const flagIndex = argumentsList.indexOf('--target');
  const inlineTarget = argumentsList.find((argument) => argument.startsWith('--target='));
  const targets = (inlineTarget?.slice(9) ?? (flagIndex >= 0 ? argumentsList[flagIndex + 1] : undefined))?.split(',') ?? supported;
  if (targets.some((target) => !supported.includes(target))) throw new Error(`Targets: ${supported.join(',')}`);
  const release = path.join(root, 'release'); await mkdir(release, { recursive: true });
  const staging = path.join(cache, 'build'); await mkdir(staging, { recursive: true });
  await prepareRuntime();
  const mainFile = path.join(staging, 'main.cjs');
  await build({ entryPoints: [path.join(root, 'src/main.ts')], outfile: mainFile, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'warning' });
  const hostNode = process.version === `v${versions.node}` ? process.execPath : await nodeBinary(host);
  for (const target of targets) {
    console.log(`Сборка ${target}, Node ${versions.node}`);
    const assetsDir = path.join(staging, target); await rm(assetsDir, { recursive: true, force: true }); await cp(runtime, assetsDir, { recursive: true });
    for (const name of ['cloudflared', 'cloudflared.exe']) await rm(path.join(assetsDir, name), { force: true });
    const tunnelName = target.startsWith('win-') ? 'cloudflared.exe' : 'cloudflared';
    await copyFile(await cloudflared(target), path.join(assetsDir, tunnelName));
    const manifest = await writeManifest(assetsDir, [tunnelName]);
    const assets = Object.fromEntries(['manifest.json', ...Object.keys(manifest.files)].map((name) => [name, path.join(assetsDir, name)]));
    const blob = path.join(staging, `${target}.blob`);
    const seaConfig = path.join(staging, `${target}.json`);
    await writeFile(seaConfig, JSON.stringify({ main: mainFile, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }));
    await execute(hostNode, ['--experimental-sea-config', seaConfig], { maxBuffer: 1024 * 1024 });
    const executable = path.join(release, `documents-mcp-${target}${target.startsWith('win-') ? '.exe' : ''}`);
    await copyFile(await nodeBinary(target), executable); await chmod(executable, 0o755);
    if (target.startsWith('darwin-')) {
      if (process.platform !== 'darwin') throw new Error('A macOS host with codesign is required to build and ad-hoc sign the Darwin executable.');
      await execute('codesign', ['--remove-signature', executable]);
    }
    await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(target.startsWith('darwin-') ? { machoSegmentName: 'NODE_SEA' } : {}) });
    if (target.startsWith('darwin-')) await execute('codesign', ['--sign', '-', executable]);
    console.log(`${path.basename(executable)}: ${(await stat(executable)).size} байт`);
  }
  const entries = (await readdir(release)).filter((name) => /^documents-mcp-(?:linux-(?:x64|arm64)|darwin-arm64|win-x64\.exe)$/u.test(name)).sort();
  await writeFile(path.join(release, 'SHA256SUMS'), (await Promise.all(entries.map(async (name) => `${digest(await readFile(path.join(release, name)))}  ${name}`))).join('\n') + '\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
