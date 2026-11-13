import opentype from 'opentype.js';
import { PNG } from 'pngjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import encode, { init } from '@jsquash/webp/encode.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fontFile = path.join(root, '.cache/NotoSans.ttf');
await mkdir(path.dirname(fontFile), { recursive: true });
try { await readFile(fontFile); }
catch {
  const response = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf');
  if (!response.ok) throw new Error('Font download failed');
  await writeFile(fontFile, Buffer.from(await response.arrayBuffer()));
}
const bytes = await readFile(fontFile);
const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const png = new PNG({ width: 1500, height: 360 }); png.data.fill(255);
for (const [line, text] of ['ДОГОВОР ПОСТАВКИ', 'Оплата в течение тридцати дней'].entries()) {
  const commands = font.getPath(text, 60, 130 + line * 135, 62).commands;
  const edges = [];
  let current = [0, 0]; let first = current;
  const add = (point) => { edges.push([current, point]); current = point; };
  for (const command of commands) {
    if (command.type === 'M') { current = [command.x, command.y]; first = current; }
    else if (command.type === 'L') add([command.x, command.y]);
    else if (command.type === 'Z') add(first);
    else if (command.type === 'Q' || command.type === 'C') {
      const start = current;
      for (let step = 1; step <= 24; step++) {
        const fraction = step / 24; const inverse = 1 - fraction;
        add(command.type === 'Q' ? [inverse ** 2 * start[0] + 2 * inverse * fraction * command.x1 + fraction ** 2 * command.x, inverse ** 2 * start[1] + 2 * inverse * fraction * command.y1 + fraction ** 2 * command.y] : [inverse ** 3 * start[0] + 3 * inverse ** 2 * fraction * command.x1 + 3 * inverse * fraction ** 2 * command.x2 + fraction ** 3 * command.x, inverse ** 3 * start[1] + 3 * inverse ** 2 * fraction * command.y1 + 3 * inverse * fraction ** 2 * command.y2 + fraction ** 3 * command.y]);
      }
    }
  }
  for (let row = 0; row < png.height; row++) {
    const scan = row + 0.5;
    const intersections = edges.filter(([start, end]) => (start[1] <= scan && end[1] > scan) || (end[1] <= scan && start[1] > scan)).map(([start, end]) => start[0] + (scan - start[1]) / (end[1] - start[1]) * (end[0] - start[0])).sort((left, right) => left - right);
    for (let index = 0; index < intersections.length; index += 2) for (let column = Math.max(0, Math.ceil(intersections[index])); column < Math.min(png.width, intersections[index + 1]); column++) png.data.fill(0, (row * png.width + column) * 4, (row * png.width + column) * 4 + 3);
  }
}
await mkdir(path.join(root, 'test/fixtures'), { recursive: true });
await writeFile(path.join(root, 'test/fixtures/russian.png'), PNG.sync.write(png));
const require = createRequire(import.meta.url);
await init(await WebAssembly.compile(await readFile(require.resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm'))));
await writeFile(path.join(root, 'test/fixtures/russian.webp'), Buffer.from(await encode({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }, { quality: 90 })));
