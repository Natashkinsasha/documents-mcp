import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { textExtensions, imageExtensions } from './formats.js';
import { extractText } from './text.js';
import { extractDocx, extractDoc } from './word.js';
import { extractExcel } from './excel.js';
import { extractPdf } from './pdf.js';
import { extractImage } from './image.js';
import { extractPowerpoint } from './powerpoint.js';
import { OcrEngine } from './ocr.js';
import { MAX_TEXT, OCR_DEFERRED, UserError, UnsupportedError, type Extraction } from '../types.js';

const data = workerData as { runtime: string; langs: string[]; ocrMaxPages: number };
const ocr = new OcrEngine(data.runtime, data.langs);
async function run(file: string, recognize: boolean): Promise<Extraction> {
  const extension = path.extname(file).toLowerCase();
  let result: Extraction;
  if (textExtensions.has(extension)) result = { parts: await extractText(file, extension), partial: false };
  else if (extension === '.docx') result = { parts: await extractDocx(file), partial: false };
  else if (extension === '.doc') result = { parts: await extractDoc(file), partial: false };
  else if (['.xlsx', '.xls', '.ods'].includes(extension)) result = await extractExcel(file);
  else if (extension === '.pdf') result = await extractPdf(file, data.runtime, ocr, data.ocrMaxPages, recognize);
  else if (imageExtensions.has(extension)) result = recognize ? { parts: await extractImage(file, ocr), partial: false } : { parts: [], partial: true, reason: OCR_DEFERRED, ocrDeferred: true };
  else if (extension === '.pptx') result = { parts: await extractPowerpoint(file), partial: false };
  else throw new UserError('Неподдерживаемый тип файла.');
  let remaining = MAX_TEXT;
  result.parts = result.parts.filter((part) => {
    if (part.text.length > remaining) { result.partial = true; result.reason = 'Достигнут предел извлечённого текста.'; }
    part.text = part.text.slice(0, Math.max(remaining, 0));
    remaining -= part.text.length;
    return part.text.length > 0;
  });
  return result;
}
let queue = Promise.resolve();
parentPort!.on('message', (message: { id: number; file?: string; stop?: boolean; recognize?: boolean }) => {
  queue = queue.then(async () => {
    if (message.stop) { await ocr.close(); parentPort!.close(); return; }
    try { parentPort!.postMessage({ id: message.id, result: await run(message.file!, message.recognize !== false) }); }
    catch (error) { parentPort!.postMessage({ id: message.id, ...(error instanceof UnsupportedError ? { result: { parts: [], partial: false, unsupported: true, reason: error.message } } : { error: error instanceof UserError ? error.message : 'Не удалось извлечь текст: файл повреждён, защищён или превышено время обработки.' }) }); }
  });
});
