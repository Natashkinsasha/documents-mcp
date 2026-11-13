import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { Parser } from 'htmlparser2';
import type { Part } from '../types.js';

export async function extractPowerpoint(file: string): Promise<Part[]> {
  let expanded = 0;
  const files = unzipSync(await readFile(file), { filter(entry) {
    if (!/^ppt\/slides\/slide\d+\.xml$/u.test(entry.name)) return false;
    expanded += entry.originalSize;
    if (expanded > 64 * 1024 * 1024) throw new Error('Expanded archive limit');
    return true;
  } });
  return Object.keys(files).sort((left, right) => left.localeCompare(right, 'en', { numeric: true })).map((name, index) => {
    let inText = false;
    const text: string[] = [];
    const parser = new Parser({
      onopentag(tag) { if (tag === 'a:t') inText = true; },
      ontext(value) { if (inText) text.push(value); },
      onclosetag(tag) { if (tag === 'a:t') inText = false; if (tag === 'a:p') text.push('\n'); },
    }, { xmlMode: true, decodeEntities: true });
    parser.end(strFromU8(files[name]!));
    return { label: `Слайд ${index + 1}`, text: text.join('') };
  });
}
