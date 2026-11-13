import snowball from 'snowball-stemmers';
import type { Chunk, Part } from '../types.js';

const russian = snowball.newStemmer('russian');
const english = snowball.newStemmer('english');

export function stemWord(word: string): string {
  const normalized = word.toLowerCase().replace(/ё/gu, 'е');
  if (/^[\p{Script=Cyrillic}]+$/u.test(normalized)) return russian.stem(normalized);
  if (/^[a-z]+$/u.test(normalized)) return english.stem(normalized);
  return normalized;
}

export function tokens(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map(stemWord).filter(Boolean);
}

export function buildQuery(query: string, mode: 'AND' | 'OR' = 'AND'): string | null {
  const words = tokens(query).slice(0, 40);
  if (!words.length) return null;
  return words.map((word, index) => `"${word.replace(/"/gu, '""')}"${index === words.length - 1 ? '*' : ''}`).join(` ${mode} `);
}

export function chunkParts(parts: Part[], target = 1500): Chunk[] {
  const chunks: Chunk[] = [];
  for (const part of parts) {
    let start = 0;
    while (start < part.text.length) {
      let end = Math.min(start + target, part.text.length);
      if (end < part.text.length) {
        const boundary = part.text.lastIndexOf('\n', end - 1);
        if (boundary >= start + target / 2) end = boundary + 1;
        else {
          const whitespace = part.text.lastIndexOf(' ', end - 1);
          if (whitespace >= start + target / 2) end = whitespace + 1;
        }
      }
      chunks.push({ seq: chunks.length, label: part.label, text: part.text.slice(start, end) });
      start = end;
    }
  }
  return chunks;
}

export function renderChunks(chunks: Pick<Chunk, 'label' | 'text'>[]): string {
  let label: string | undefined;
  let result = '';
  for (const chunk of chunks) {
    if (chunk.label !== label) {
      if (result) result += '\n\n';
      if (chunk.label) result += `--- ${chunk.label} ---\n`;
      label = chunk.label;
    }
    result += chunk.text;
  }
  return result;
}

export function excerpt(text: string, query: string): string {
  const words = tokens(query).slice(0, 40);
  let position = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const stem = stemWord(match[0]);
    if (words.some((word, index) => stem === word || index === words.length - 1 && stem.startsWith(word))) { position = match.index; break; }
  }
  const start = Math.max(0, position - 100);
  const end = Math.min(text.length, start + 300);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ')}${end < text.length ? '…' : ''}`;
}
