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

const MAX_QUERY_WORDS = 40;

/** The query's words as typed: those joined by punctuation (ЛП-0419, 4.2) stay one term. */
function queryTerms(query: string): string[][] {
  const terms: string[][] = [];
  let room = MAX_QUERY_WORDS;
  for (const piece of query.split(/\s+/u)) {
    const words = tokens(piece).slice(0, room);
    if (!words.length) continue;
    terms.push(words);
    room -= words.length;
    if (!room) break;
  }
  return terms;
}

/** All terms must match, a joined term as a phrase; `OR` is the fallback and takes every word on its own. */
export function buildQuery(query: string, mode: 'AND' | 'OR' = 'AND'): string | null {
  const terms = queryTerms(query);
  const parts = mode === 'AND' ? terms.map((term) => term.join(' ')) : terms.flat();
  if (!parts.length) return null;
  return parts.map((part, index) => `"${part.replace(/"/gu, '""')}"${index === parts.length - 1 ? '*' : ''}`).join(` ${mode} `);
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

function* renderedChunks<Item extends Pick<Chunk, 'label' | 'text'>>(chunks: Iterable<Item>): Generator<{ chunk: Item; head: string; start: number }> {
  let label: string | undefined;
  let length = 0;
  for (const chunk of chunks) {
    let head = '';
    if (chunk.label !== label) {
      if (length) head += '\n\n';
      if (chunk.label) head += `--- ${chunk.label} ---\n`;
      label = chunk.label;
    }
    yield { chunk, head, start: length + head.length };
    length += head.length + chunk.text.length;
  }
}

export function renderChunks(chunks: Pick<Chunk, 'label' | 'text'>[]): string {
  let result = '';
  for (const { chunk, head } of renderedChunks(chunks)) result += head + chunk.text;
  return result;
}

/** Where the wanted chunks start in the rendered text, in the UTF-16 units read_document counts. */
export function chunkStarts(chunks: Iterable<Chunk>, wanted: ReadonlySet<number>): Map<number, number> {
  const starts = new Map<number, number>();
  for (const { chunk, start } of renderedChunks(chunks)) {
    if (wanted.has(chunk.seq)) starts.set(chunk.seq, start);
    if (starts.size === wanted.size) break;
  }
  return starts;
}

export function excerpt(text: string, query: string): string {
  const terms = queryTerms(query);
  const words = terms.flat();
  const found = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ stem: stemWord(match[0]), index: match.index }));
  const fits = (stem: string | undefined, word: string, open: boolean) => stem !== undefined && (stem === word || open && stem.startsWith(word));
  const phraseAt = (term: string[], open: boolean, at: number) => term.every((word, index) => fits(found[at + index]?.stem, word, open && index === term.length - 1));
  // A code typed as one term is what the reader is after, even when one of its words comes earlier on its own.
  const phrase = found.find((_, at) => terms.some((term, index) => term.length > 1 && phraseAt(term, index === terms.length - 1, at)));
  const word = phrase ?? found.find(({ stem }) => words.some((item, index) => fits(stem, item, index === words.length - 1)));
  const position = word?.index ?? 0;
  const start = Math.max(0, position - 100);
  const end = Math.min(text.length, start + 300);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ')}${end < text.length ? '…' : ''}`;
}
