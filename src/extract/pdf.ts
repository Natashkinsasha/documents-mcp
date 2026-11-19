import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import { InterruptedError, MAX_TEXT, OCR_DEFERRED, type Extraction, type Part } from '../types.js';
import type { OcrEngine } from './ocr.js';

interface TextItem { str: string; transform: number[]; width: number; height: number; hasEOL: boolean }
interface Pixels { width: number; height: number; kind: number; data: Uint8Array }

export function readingOrder(items: TextItem[]): string {
  const lines: { y: number; height: number; items: TextItem[] }[] = [];
  for (const item of items) {
    if (!item.str && !item.hasEOL) continue;
    const baseline = item.transform[5]!;
    const height = Math.abs(item.height || item.transform[3]! || 10);
    const line = lines.find((line) => Math.abs(line.y - baseline) < Math.max(2, Math.min(height, line.height) * 0.4));
    if (line) line.items.push(item);
    else lines.push({ y: baseline, height, items: [item] });
  }
  return lines.sort((left, right) => right.y - left.y).map((line) => {
    const sorted = line.items.sort((left, right) => left.transform[4]! - right.transform[4]!);
    let output = ''; let previous: TextItem | undefined;
    for (const item of sorted) {
      if (previous && output && !/\s$/u.test(output) && !/^\s/u.test(item.str)) {
        const gap = item.transform[4]! - previous.transform[4]! - previous.width;
        output += gap > line.height * 1.5 ? '\t' : gap > line.height * 0.1 || previous.hasEOL ? ' ' : '';
      }
      output += item.str;
      previous = item;
    }
    return output.trimEnd();
  }).join('\n').trim();
}

export function pixelsToPng(image: Pixels): Buffer {
  const { width, height, kind, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > 36_000_000) throw new Error('Предел размера изображения.');
  const rgba = Buffer.alloc(width * height * 4, 255);
  const stride = Math.ceil(width / 8);
  const expected = kind === 3 ? width * height * 4 : kind === 2 ? width * height * 3 : kind === 1 ? stride * height : width * height;
  if (data.length < expected) throw new Error('Повреждённое изображение.');
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const pixel = row * width + column;
    if (kind === 3) {
      const alpha = data[pixel * 4 + 3]! / 255;
      for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = Math.round(data[pixel * 4 + channel]! * alpha + 255 * (1 - alpha));
    } else if (kind === 2) {
      for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = data[pixel * 3 + channel]!;
    } else {
      const value = kind === 1 ? ((data[row * stride + (column >> 3)]! >> (7 - (column & 7))) & 1) * 255 : data[pixel]!;
      rgba.fill(value, pixel * 4, pixel * 4 + 3);
    }
  }
  const png = new PNG({ width, height }); png.data = rgba;
  return PNG.sync.write(png);
}

export interface PdfProgress {
  /** Pages recognized by an earlier, unfinished run of this same file version. */
  known?: ReadonlyMap<number, string>;
  /** Asked before each page to recognize: true ends the run there, with `yielded` set. */
  shouldYield?: () => boolean;
  /** Called after every page; `text` is present when this run recognized the page. */
  onPage?: (page: number, text?: string) => void;
}

export async function extractPdf(file: string, runtime: string, ocr: OcrEngine, maxPages: number, recognize = true, progress: PdfProgress = {}): Promise<Extraction> {
  const library = await import(pathToFileURL(path.join(runtime, 'pdf/index.mjs')).href) as typeof import('unpdf');
  library.registerImageDecoders();
  const document = await library.getDocumentProxy(new Uint8Array(await readFile(file)), { isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 36_000_000, verbosity: 0 });
  const parts: Part[] = [];
  const scanPages: number[] = [];
  let ocrPages = 0; let characters = 0; let partial = false; let reason: string | undefined; let deferred = false; let retryPages = false;
  try {
    const { OPS } = await import(pathToFileURL(path.join(runtime, 'pdf/pdfjs.mjs')).href);
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        let text = readingOrder(content.items.filter((item) => 'str' in item) as TextItem[]);
        let recognized = false;
        if ((text.match(/\p{L}/gu) ?? []).length < 20) {
          scanPages.push(number);
          const known = progress.known?.get(number);
          if (!recognize) deferred = true;
          else if (known !== undefined) { ocrPages++; text = known; }
          else if (ocrPages >= maxPages) { partial = true; reason = 'Достигнут предел страниц для распознавания.'; }
          else {
            if (progress.shouldYield?.()) return { parts, partial: true, reason: OCR_DEFERRED, ocrDeferred: true, yielded: true, scanPages };
            ocrPages++;
            try {
              const operators = await page.getOperatorList();
              let largest: Pixels | undefined;
              for (const [index, operation] of operators.fnArray.entries()) {
                const args = operators.argsArray[index]!;
                let image: Pixels | undefined;
                if (operation === OPS.paintInlineImageXObject) image = args[0];
                if (operation === OPS.paintImageXObject) {
                  const key = args[0] as string;
                  const objects = key.startsWith('g_') ? page.commonObjs : page.objs;
                  image = await new Promise<Pixels>((resolve) => objects.get(key, resolve));
                }
                if (image?.data && (!largest || image.width * image.height > largest.width * largest.height)) largest = image;
              }
              if (!largest) throw new Error('На странице нет доступного изображения.');
              text = await ocr.recognize(pixelsToPng(largest));
              recognized = true;
            } catch (error) { partial = true; reason = 'Не удалось распознать часть страниц.'; retryPages ||= error instanceof InterruptedError; }
          }
        }
        progress.onPage?.(number, recognized ? text : undefined);
        characters += text.length;
        parts.push({ label: `Страница ${number}`, text });
        if (characters > MAX_TEXT) { partial = true; reason = 'Достигнут предел извлечённого текста.'; break; }
      } finally { page.cleanup(); }
    }
    return deferred ? { parts, partial: true, reason: OCR_DEFERRED, ocrDeferred: true, scanPages } : { parts, partial, reason, scanPages, ...(retryPages ? { retryPages } : {}) };
  } finally { await document.loadingTask.destroy(); }
}
