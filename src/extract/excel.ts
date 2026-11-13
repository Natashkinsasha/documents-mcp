import * as XLSX from 'xlsx';
import { readFile } from 'node:fs/promises';
import { MAX_TEXT, type Extraction, type Part } from '../types.js';

export async function extractExcel(file: string): Promise<Extraction> {
  const workbook = XLSX.read(await readFile(file), { type: 'buffer', cellDates: true, sheetRows: 100_001 });
  const parts: Part[] = [];
  let partial = false;
  let total = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]!;
    if (sheet['!fullref']) partial = true;
    const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
    if (range.e.c > 999) { range.e.c = 999; sheet['!ref'] = XLSX.utils.encode_range(range); partial = true; }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '', raw: true, UTC: true });
    const lines: string[] = [];
    for (const row of rows) {
      const cells = row.map((value) => value instanceof Date ? value.toISOString() : String(value ?? '').replace(/[\r\n\t]/gu, ' '));
      while (cells[cells.length - 1] === '') cells.pop();
      if (!cells.some((value) => value.trim())) continue;
      const line = cells.join('\t');
      total += line.length + 1;
      if (total > MAX_TEXT) { partial = true; break; }
      lines.push(line);
    }
    parts.push({ label: `Лист «${name}»`, text: lines.join('\n') });
    if (total > MAX_TEXT) break;
  }
  return { parts, partial, ...(partial ? { reason: 'Достигнут предел объёма таблицы.' } : {}) };
}
