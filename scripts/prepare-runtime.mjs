import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const root = fileURLToPath(new URL('../', import.meta.url));
export const runtime = path.join(root, 'dist/runtime');
export async function prepareRuntime() {
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  const options = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'warning' };
  await build({ ...options, entryPoints: [path.join(root, 'src/extract/worker.ts')], outfile: path.join(runtime, 'extract-worker.cjs') });
  const tess = path.dirname(require.resolve('tesseract.js/package.json'));
  await build({ ...options, entryPoints: [path.join(tess, 'src/worker-script/node/index.js')], outfile: path.join(runtime, 'tesseract-worker.cjs'), external: ['tesseract.js-core/*'] });
  await writeFile(path.join(runtime, 'package.json'), '{"type":"commonjs"}');
  const copy = async (source, name) => { await mkdir(path.dirname(path.join(runtime, name)), { recursive: true }); await copyFile(source, path.join(runtime, name)); };
  const core = path.dirname(createRequire(path.join(tess, 'package.json')).resolve('tesseract.js-core/package.json'));
  for (const name of ['tesseract-core', 'tesseract-core-simd', 'tesseract-core-lstm', 'tesseract-core-simd-lstm']) {
    for (const suffix of ['.js', '.wasm']) await copy(path.join(core, name + suffix), `node_modules/tesseract.js-core/${name}${suffix}`);
  }
  await copy(path.join(core, 'package.json'), 'node_modules/tesseract.js-core/package.json');
  await copy(path.join(core, 'LICENSE'), 'licenses/tesseract-core.txt');
  await copy(path.join(tess, 'LICENSE.md'), 'licenses/tesseract-js.txt');
  for (const lang of ['rus', 'bel', 'eng']) {
    const directory = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    await copy(path.join(directory, '4.0.0_best_int', `${lang}.traineddata.gz`), `lang/${lang}.traineddata.gz`);
  }
  const pdf = path.dirname(require.resolve('unpdf'));
  for (const name of await readdir(pdf)) if (name.endsWith('.mjs')) await copy(path.join(pdf, name), `pdf/${name}`);
  await writeFile(path.join(runtime, 'pdf/index.mjs'), (await readFile(path.join(pdf, 'index.mjs'), 'utf8')).replace('import("unpdf/pdfjs")', 'import("./pdfjs.mjs")'));
  await writeFile(path.join(runtime, 'pdf/package.json'), JSON.stringify({ type: 'module', imports: { '#pdfjs-decoders': './pdfjs-decoders.mjs' } }));
  for (const name of await readdir(path.join(pdf, 'licenses'))) await copy(path.join(pdf, 'licenses', name), `licenses/${name}`);
  const versions = JSON.parse(await readFile(path.join(root, 'scripts/binary-versions.json'), 'utf8'));
  const host = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  const tunnelName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  await copyFile(path.join(root, `.cache/cloudflared-${versions.cloudflared.version}-${host}${process.platform === 'win32' ? '.exe' : ''}`), path.join(runtime, tunnelName)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return writeManifest(runtime, [tunnelName]);
}
export async function writeManifest(directory, executables = []) {
  const files = {};
  async function walk(relative = '') {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (name !== 'manifest.json') files[name] = { sha256: createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex'), ...(executables.includes(name) ? { executable: true } : {}) };
    }
  }
  await walk();
  const manifest = { files };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareRuntime();
