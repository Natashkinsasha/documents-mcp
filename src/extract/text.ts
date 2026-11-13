import { readFile } from 'node:fs/promises';
import { Parser } from 'htmlparser2';
import type { Part } from '../types.js';

export function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1251').decode(bytes); }
}

export function htmlToText(html: string): string {
  const output: string[] = [];
  let hidden = 0;
  let cell: string[] | undefined;
  const emit = (text: string) => { (cell ?? output).push(text); };
  const parser = new Parser({
    onopentag(name) {
      if (['script', 'style', 'noscript'].includes(name)) hidden++;
      if (hidden) return;
      if (['td', 'th'].includes(name)) { cell = []; return; }
      if (['br', 'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'table'].includes(name)) emit(cell ? ' ' : '\n');
    },
    ontext(text) { if (!hidden) emit(text); },
    onclosetag(name) {
      if (['script', 'style', 'noscript'].includes(name)) { hidden = Math.max(0, hidden - 1); return; }
      if (hidden) return;
      if (['td', 'th'].includes(name)) { output.push((cell ?? []).join('').replace(/\s+/gu, ' ').trim(), ' | '); cell = undefined; }
      if (['p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'table'].includes(name)) emit(cell ? ' ' : '\n');
    },
  }, { decodeEntities: true });
  parser.end(html);
  return output.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

export function rtfToText(source: string): string {
  const stack: { hidden: boolean; skip: number }[] = [{ hidden: false, skip: 1 }];
  let output = '';
  let fallback = 0;
  const tokens = source.match(/\\'[0-9a-f]{2}|\\[a-z]+-?\d* ?|\\[^a-z]|[{}]|[^\\{}]+/giu) ?? [];
  for (const token of tokens) {
    const state = stack[stack.length - 1]!;
    if (token === '{') { stack.push({ ...state }); continue; }
    if (token === '}') { if (stack.length > 1) stack.pop(); continue; }
    if (/^\\(?:fonttbl|colortbl|stylesheet|info|pict|object)\b/u.test(token) || token === '\\*') { state.hidden = true; continue; }
    if (state.hidden) continue;
    if (/^\\uc\d+/u.test(token)) { state.skip = Number(token.match(/\d+/u)![0]); continue; }
    if (/^\\u-?\d+/u.test(token)) { output += String.fromCharCode(Number(token.match(/-?\d+/u)![0]) & 0xffff); fallback = state.skip; continue; }
    let text = token;
    if (/^\\'/u.test(token)) text = new TextDecoder('windows-1251').decode(Buffer.from([parseInt(token.slice(2), 16)]));
    else if (/^\\(?:par|line)\b/u.test(token)) text = '\n';
    else if (/^\\tab\b/u.test(token)) text = '\t';
    else if (/^\\[{}\\]$/u.test(token)) text = token.slice(1);
    else if (token.startsWith('\\')) continue;
    if (fallback) { const count = Math.min(fallback, text.length); text = text.slice(count); fallback -= count; }
    output += text;
  }
  return output.trim();
}

export async function extractText(file: string, extension: string): Promise<Part[]> {
  let text = decodeText(await readFile(file));
  if (['.html', '.htm'].includes(extension)) text = htmlToText(text);
  if (extension === '.rtf') text = rtfToText(text);
  return [{ label: '', text: text.replace(/\r\n?/gu, '\n').replace(/^\uFEFF/u, '') }];
}
