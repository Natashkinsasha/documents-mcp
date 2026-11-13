import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { extractPdf, pixelsToPng, readingOrder } from '../src/extract/pdf.js';
import { extractImage } from '../src/extract/image.js';
import { OcrEngine } from '../src/extract/ocr.js';
import { prepareRuntime } from '../src/runtime.js';
import { tempProject, textPdf, scannedPdf, projectRoot } from './helpers.js';
import jpeg from 'jpeg-js';

test('generated text PDF is read without Poppler, page labels preserved', async (context) => {
  const fixture = await tempProject('pdf'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const runtime = await prepareRuntime(fixture.config.indexDir);
  const ocr = new OcrEngine(runtime, ['rus']); context.after(() => ocr.close());
  const file = path.join(fixture.docs, 'text.pdf'); await textPdf(file);
  const result = await extractPdf(file, runtime, ocr, 1);
  assert.equal(result.partial, false); assert.equal(result.parts[0]?.label, 'Страница 1'); assert.match(result.parts[0]?.text ?? '', /Supply contract/u);
});

test('bundled offline Russian OCR, scanned PDF and page cap use one worker', async (context) => {
  const fixture = await tempProject('ocr'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const runtime = await prepareRuntime(fixture.config.indexDir);
  const ocr = new OcrEngine(runtime, ['rus', 'bel', 'eng']); context.after(() => ocr.close());
  const image = path.join(projectRoot, 'test/fixtures/russian.png');
  const parts = await extractImage(image, ocr);
  assert.match(parts[0]?.text ?? '', /ДОГОВОР ПОСТАВКИ/u); assert.match(parts[0]?.text ?? '', /тридцати дней/u);
  const worker = (ocr as unknown as { worker: unknown }).worker;
  const pdf = path.join(fixture.docs, 'scan.pdf'); await scannedPdf(pdf, image, 2);
  const result = await extractPdf(pdf, runtime, ocr, 1);
  assert.equal(result.partial, true); assert.match(result.reason!, /предел страниц/u);
  assert.match(result.parts[0]?.text ?? '', /ДОГОВОР ПОСТАВКИ/u);
  assert.equal(result.parts[1]?.text, '');
  assert.equal((ocr as unknown as { worker: unknown }).worker, worker);
});

test('PDF pixels support RGB, transparent RGBA, row-padded monochrome and grayscale', () => {
  for (const image of [
    { width: 2, height: 1, kind: 2, data: Uint8Array.from([0, 0, 0, 255, 255, 255]) },
    { width: 2, height: 1, kind: 3, data: Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 0]) },
    { width: 2, height: 1, kind: 1, data: Uint8Array.from([0b01000000]) },
    { width: 2, height: 1, kind: 0, data: Uint8Array.from([0, 255]) },
  ]) {
    const decoded = PNG.sync.read(pixelsToPng(image));
    assert.deepEqual([...decoded.data], [0, 0, 0, 255, 255, 255, 255, 255]);
  }
  assert.throws(() => pixelsToPng({ width: 100000, height: 100000, kind: 2, data: new Uint8Array() }));
});

test('positioned text retains rows and table columns', () => {
  const item = (str: string, horizontal: number, vertical: number, hasEOL = false) => ({ str, transform: [1, 0, 0, 12, horizontal, vertical], width: str.length * 6, height: 12, hasEOL });
  assert.equal(readingOrder([item('12500', 150, 50), item('Цена', 150, 70, true), item('Насос', 10, 50), item('Товар', 10, 70)]), 'Товар\tЦена\nНасос\t12500');
});

test('offline OCR reads JPEG, BMP, TIFF and WEBP; unknown image signatures are unsupported', async (context) => {
  const fixture = await tempProject('image-formats'); context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const ocr = new OcrEngine(await prepareRuntime(fixture.config.indexDir), ['rus']); context.after(() => ocr.close());
  const image = PNG.sync.read(await readFile(path.join(projectRoot, 'test/fixtures/russian.png')));
  const jpg = jpeg.encode({ width: image.width, height: image.height, data: image.data }, 90).data;
  const stride = Math.ceil(image.width * 3 / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * image.height);
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(image.width, 18); bmp.writeInt32LE(image.height, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  for (let row = 0; row < image.height; row++) for (let column = 0; column < image.width; column++) for (let channel = 0; channel < 3; channel++) bmp[54 + (image.height - row - 1) * stride + column * 3 + channel] = image.data[(row * image.width + column) * 4 + 2 - channel]!;
  const entries = [[256, 4, image.width], [257, 4, image.height], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 8 + 2 + 9 * 12 + 4], [277, 3, 1], [278, 4, image.height], [279, 4, image.width * image.height]];
  const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4 + image.width * image.height);
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(entries.length, 8);
  for (const [index, entry] of entries.entries()) { const offset = 10 + index * 12; tiff.writeUInt16LE(entry[0]!, offset); tiff.writeUInt16LE(entry[1]!, offset + 2); tiff.writeUInt32LE(1, offset + 4); tiff.writeUInt32LE(entry[2]!, offset + 8); }
  for (let pixel = 0; pixel < image.width * image.height; pixel++) tiff[8 + 2 + entries.length * 12 + 4 + pixel] = image.data[pixel * 4]!;
  for (const bytes of [jpg, bmp, tiff]) assert.match(await ocr.recognize(bytes), /ДОГОВОР ПОСТАВКИ/u);
  assert.match((await extractImage(path.join(projectRoot, 'test/fixtures/russian.webp'), ocr))[0]!.text, /ДОГОВОР ПОСТАВКИ/u);
  const { writeFile } = await import('node:fs/promises');
  const file = path.join(fixture.docs, 'unknown.png'); await writeFile(file, 'not an image');
  await assert.rejects(extractImage(file, ocr), /Формат изображения не поддерживается/u);
});
