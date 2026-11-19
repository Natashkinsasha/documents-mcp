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

// Commas and semicolons separate listed words, except inside a number such as 4,5.
const SEPARATORS = /\s+|(?<!\p{N})[,;]|[,;](?!\p{N})/u;

/** The query's words as typed: those joined by punctuation (ЛП-0419, 4.2) stay one term. */
function queryTerms(query: string): string[][] {
  const terms: string[][] = [];
  let room = MAX_QUERY_WORDS;
  for (const piece of query.split(SEPARATORS)) {
    const words = tokens(piece).slice(0, room);
    if (!words.length) continue;
    terms.push(words);
    room -= words.length;
    if (!room) break;
  }
  return terms;
}

/**
 * The passes a search tries in turn. `PHRASE` needs every term, a joined one as written, and is skipped when the
 * query has no joined term; `AND` needs every word in any order; `OR` is the last resort and needs any word.
 */
export type QueryMode = 'PHRASE' | 'AND' | 'OR';

export function buildQuery(query: string, mode: QueryMode = 'AND'): string | null {
  const terms = queryTerms(query);
  if (mode === 'PHRASE' && !terms.some((term) => term.length > 1)) return null;
  const parts = mode === 'PHRASE' ? terms.map((term) => term.join(' ')) : terms.flat();
  if (!parts.length) return null;
  return parts.map((part, index) => `"${part.replace(/"/gu, '""')}"${index === parts.length - 1 ? '*' : ''}`).join(mode === 'OR' ? ' OR ' : ' AND ');
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

/** Each chunk with where its text starts in the rendered text, in the UTF-16 units read_document counts. */
export function* renderedChunks<Item extends Pick<Chunk, 'label' | 'text'>>(chunks: Iterable<Item>): Generator<{ chunk: Item; head: string; start: number }> {
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

/** A fragment around the query's best match, and where in `text` the fragment starts. */
export function excerpt(text: string, query: string): { text: string; start: number } {
  const terms = queryTerms(query);
  const words = terms.flat();
  const found = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ stem: stemWord(match[0]), index: match.index }));
  const fits = (stem: string | undefined, word: string, open: boolean) => stem !== undefined && (stem === word || open && stem.startsWith(word));
  const phraseAt = (term: string[], open: boolean, at: number) => term.every((word, index) => fits(found[at + index]?.stem, word, open && index === term.length - 1));
  // A code typed as one term is what the reader is after, even when one of its words comes earlier on its own.
  const phrase = found.find((_, at) => terms.some((term, index) => term.length > 1 && phraseAt(term, index === terms.length - 1, at)));
  const word = phrase ?? found.find(({ stem }) => words.some((item, index) => fits(stem, item, index === words.length - 1)));
  const position = word?.index ?? 0;
  let start = Math.max(0, position - 100);
  // Never between the halves of a surrogate pair: the start is also an offset to read from.
  if (/[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start--;
  const end = Math.min(text.length, start + 300);
  return { text: `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ')}${end < text.length ? '…' : ''}`, start };
}
