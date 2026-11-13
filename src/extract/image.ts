import { readFile } from 'node:fs/promises';
import { UnsupportedError, type Part } from '../types.js';
import type { OcrEngine } from './ocr.js';

export async function extractImage(file: string, ocr: OcrEngine): Promise<Part[]> {
  const bytes = await readFile(file);
  const signature = bytes.subarray(0, 8).toString('hex');
  const supported = signature.startsWith('89504e470d0a1a0a') || signature.startsWith('ffd8ff') || signature.startsWith('424d') || signature.startsWith('49492a00') || signature.startsWith('4d4d002a') || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!supported) throw new UnsupportedError('Формат изображения не поддерживается. Сохраните файл как PNG, JPEG, BMP, TIFF или WEBP.');
  return [{ label: '', text: await ocr.recognize(bytes) }];
}
