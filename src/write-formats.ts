import path from 'node:path';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, LevelFormat, WidthType } from 'docx';
import * as XLSX from 'xlsx';
import { decodeText } from './extract/text.js';
import { textExtensions } from './extract/formats.js';
import { UserError } from './types.js';

export const editable = (file: string) => textExtensions.has(path.extname(file).toLowerCase()) && path.extname(file).toLowerCase() !== '.rtf';
export const replaceable = (file: string) => ['.docx', '.xlsx'].includes(path.extname(file).toLowerCase());
export const writeAccess = (file: string) => editable(file) ? 'редактируемый текст' : replaceable(file) ? 'замена целиком (оформление теряется)' : 'только чтение';
export const modifiedDate = (mtime: number) => new Date(mtime).toISOString();

export function encodeText(content: string, original?: Buffer): Buffer {
  if (!original) return Buffer.from(content, 'utf8');
  if (original[0] === 0xff && original[1] === 0xfe) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
  if (original[0] === 0xfe && original[1] === 0xff) return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(content, 'utf16le').swap16()]);
  if (original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
  try { new TextDecoder('utf8', { fatal: true }).decode(original); return Buffer.from(content, 'utf8'); } catch {}
  const decoder = new TextDecoder('windows-1251');
  const characters = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) characters.set(decoder.decode(Buffer.from([byte])), byte);
  const bytes: number[] = [];
  for (const character of content) {
    const byte = characters.get(character);
    if (byte === undefined) throw new UserError('Символ невозможно сохранить в исходной кодировке windows-1251. Используйте поддерживаемые символы или создайте новый UTF-8 файл.');
    bytes.push(byte);
  }
  const result = Buffer.from(bytes);
  if (decodeText(result) !== content && decoder.decode(result) !== content) throw new UserError('Не удалось сохранить исходную кодировку windows-1251.');
  return result;
}

const tableCells = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
const separator = (line: string) => tableCells(line).every((cell) => /^:?-{3,}:?$/u.test(cell));
function runs(text: string): TextRun[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/gu).filter(Boolean).map((part) => new TextRun(/^\*\*[^*]+\*\*$/u.test(part) ? { text: part.slice(2, -2), bold: true } : /^\*[^*]+\*$/u.test(part) ? { text: part.slice(1, -1), italics: true } : { text: part }));
}

export async function createDocx(content: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  let listIndex = 0;
  let numbered = false;
  const numberings: { reference: string; levels: { level: number; format: typeof LevelFormat.DECIMAL; text: string }[] }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().startsWith('|')) {
      const rows: TableRow[] = [];
      while (index < lines.length && lines[index]!.trim().startsWith('|')) {
        const source = lines[index++]!;
        if (separator(source)) continue;
        const header = rows.length === 0;
        rows.push(new TableRow({ tableHeader: header, children: tableCells(source).map((cell) => new TableCell({ children: [new Paragraph({ children: header ? [new TextRun({ text: cell, bold: true })] : runs(cell) })] })) }));
      }
      index--;
      if (rows.length) children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      numbered = false;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    const bullet = /^\s*-\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/u.exec(line);
    if (ordered && !numbered) { listIndex++; numberings.push({ reference: `list-${listIndex}`, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.' }] }); }
    children.push(new Paragraph({
      children: runs(heading?.[2] ?? bullet?.[1] ?? ordered?.[1] ?? line),
      ...(heading ? { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1]!.length - 1]! } : {}),
      ...(bullet ? { bullet: { level: 0 } } : {}),
      ...(ordered ? { numbering: { reference: `list-${listIndex}`, level: 0 } } : {}),
    }));
    numbered = Boolean(ordered);
  }
  return Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 120 } } } } },
    numbering: { config: numberings },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
  }));
}

function typedCell(value: string): XLSX.CellObject {
  const trimmed = value.trim();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%$/iu.test(trimmed) && Number.isFinite(Number(trimmed.slice(0, -1)))) return { t: 'n', v: Number(trimmed.slice(0, -1)) / 100, z: '0.##%' };
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed) && Number.isFinite(Number(trimmed))) return { t: 'n', v: Number(trimmed) };
  if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.test(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === trimmed.slice(0, 10)) return { t: 'd', v: date, z: trimmed.length === 10 ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss' };
  }
  return { t: 's', v: value };
}

export function createXlsx(content: string): Buffer {
  const sections: { name: string; lines: string[] }[] = [];
  for (const line of content.replace(/\r\n?/gu, '\n').split('\n')) {
    const heading = /^##\s+Лист:\s*(.+)$/u.exec(line);
    if (heading) sections.push({ name: heading[1]!.trim(), lines: [] });
    else {
      if (!sections.length && !line.trim()) continue;
      if (!sections.length) sections.push({ name: 'Лист1', lines: [] });
      sections.at(-1)!.lines.push(line);
    }
  }
  if (!sections.length) sections.push({ name: 'Лист1', lines: [] });
  const workbook = XLSX.utils.book_new();
  for (const section of sections) {
    if (section.name.length > 31 || /[\\/?:*\[\]]/u.test(section.name) || /^'|'$/u.test(section.name) || workbook.SheetNames.some((name) => name.toLowerCase() === section.name.toLowerCase())) throw new UserError('Недопустимое или повторяющееся имя листа Excel (максимум 31 символ).');
    const source = section.lines.join('\n');
    let rows: string[][];
    if (source.trimStart().startsWith('|')) rows = section.lines.filter((line) => line.trim().startsWith('|') && !separator(line)).map(tableCells);
    else if (!source.trim()) rows = [];
    else {
      const parsed = XLSX.read(source, { type: 'string', raw: true, FS: source.includes('\t') ? '\t' : ',' });
      rows = XLSX.utils.sheet_to_json<string[]>(parsed.Sheets[parsed.SheetNames[0]!]!, { header: 1, raw: true, defval: '' });
    }
    if (rows.length > 1048576 || rows.some((row) => row.length > 16384)) throw new UserError('Таблица превышает предел строк или столбцов Excel.');
    const sheet = XLSX.utils.aoa_to_sheet(rows.map((row, index) => row.map((value) => index === 0 ? { t: 's' as const, v: String(value) } : typedCell(String(value)))), { cellDates: true });
    const widths: number[] = [];
    for (const row of rows) row.forEach((cell, column) => { widths[column] = Math.max(widths[column] ?? 8, Math.min(60, String(cell).length + 2)); });
    sheet['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, section.name);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Buffer;
}
