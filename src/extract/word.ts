import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { htmlToText } from './text.js';
import type { Part } from '../types.js';

export async function extractDocx(file: string): Promise<Part[]> {
  const result = await mammoth.convertToHtml({ path: file }, { externalFileAccess: false, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  return [{ label: '', text: htmlToText(result.value) }];
}

export async function extractDoc(file: string): Promise<Part[]> {
  const document = await new WordExtractor().extract(file);
  return [{ label: '', text: document.getBody() }];
}
