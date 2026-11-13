import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import * as XLSX from 'xlsx';
import { loadConfig, type Config } from '../src/config.js';

export const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function tempProject(prefix: string): Promise<{ directory: string; docs: string; config: Config }> {
  await mkdir(path.join(projectRoot, 'tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(projectRoot, 'tmp', `${prefix}-`));
  const docs = path.join(directory, 'docs');
  await mkdir(docs);
  const config = await loadConfig({ DOCS_ROOT: docs, MCP_TOKEN: 'a'.repeat(64), INDEX_DIR: path.join(directory, 'index'), OCR_LANGS: 'eng' });
  return { directory, docs, config };
}

export function cp1251(text: string): Buffer {
  return Buffer.from([...text].map((letter) => {
    const code = letter.charCodeAt(0);
    if (code >= 0x410 && code <= 0x44f) return code - 0x350;
    if (letter === 'Ё') return 0xa8;
    if (letter === 'ё') return 0xb8;
    return code;
  }));
}

export async function docx(file: string): Promise<void> {
  const document = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Договор поставки оборудования</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Товар</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Цена</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Насос</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12500</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>';
  await writeFile(file, zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(document),
  }));
}

export async function spreadsheet(file: string, type: 'xlsx' | 'xls' | 'ods' = 'xlsx'): Promise<void> {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Товар', 'Цена', 'Дата'], ['Поставка насоса', 12500, new Date('2026-01-15T00:00:00Z')], [], ['Запасные части', 500, ''],
  ], { cellDates: true }), 'Цены');
  await writeFile(file, XLSX.write(workbook, { type: 'buffer', bookType: type }));
}

export async function textPdf(file: string): Promise<void> {
  const stream = 'BT /F1 18 Tf 50 760 Td (Supply contract for equipment. Total price 12500.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(file, content);
}

export async function scannedPdf(file: string, image: string, pages = 1): Promise<void> {
  const png = PNG.sync.read(await readFile(image));
  const rgb = Buffer.alloc(png.width * png.height * 3);
  for (let pixel = 0; pixel < png.width * png.height; pixel++) for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = png.data[pixel * 4 + channel]!;
  const compressed = deflateSync(rgb);
  const stream = 'q 595 0 0 143 0 600 cm /Scan Do Q';
  const objects: Buffer[] = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${index + 5} 0 R`).join(' ')}] /Count ${pages} >>`), Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from('\nendstream')]), Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)];
  for (let index = 0; index < pages; index++) objects.push(Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Scan 3 0 R >> >> /Contents 4 0 R >>'));
  const chunks = [Buffer.from('%PDF-1.4\n')]; const offsets = [0]; let offset = chunks[0]!.length;
  for (const [index, object] of objects.entries()) { offsets.push(offset); const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); chunks.push(entry); offset += entry.length; }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  await writeFile(file, Buffer.concat(chunks));
}

export async function pptx(file: string): Promise<void> {
  await writeFile(file, zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Поставка оборудования</a:t></a:r></a:p></p:sld>') }));
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(name: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  const payload = Buffer.concat([Buffer.from(name), bytes]);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([header, payload, checksum]);
}
export async function scannedImage(file: string): Promise<void> {
  const glyphs: Record<string, string[]> = {
    C: ['01111','10000','10000','10000','10000','10000','01111'],
    O: ['01110','10001','10001','10001','10001','10001','01110'],
    N: ['10001','11001','11001','10101','10011','10011','10001'],
    T: ['11111','00100','00100','00100','00100','00100','00100'],
    R: ['11110','10001','10001','11110','10100','10010','10001'],
    A: ['01110','10001','10001','11111','10001','10001','10001'],
    L: ['10000','10000','10000','10000','10000','10000','11111'],
    '1': ['00100','01100','00100','00100','00100','00100','01110'],
    '2': ['01110','10001','00001','00010','00100','01000','11111'],
    '5': ['11111','10000','10000','11110','00001','10001','01110'],
    '0': ['01110','10001','10011','10101','11001','10001','01110'],
  };
  const width = 1100; const height = 240; const scale = 7;
  const pixels = Buffer.alloc((width + 1) * height, 255);
  for (let row = 0; row < height; row++) pixels[row * (width + 1)] = 0;
  for (const [lineIndex, line] of ['CONTRACT', 'TOTAL 12500'].entries()) {
    for (const [letterIndex, letter] of [...line].entries()) {
      const glyph = glyphs[letter];
      if (!glyph) continue;
      for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) if (glyph[row]![column] === '1') {
        for (let vertical = 0; vertical < scale; vertical++) for (let horizontal = 0; horizontal < scale; horizontal++) {
          const pixelRow = 40 + lineIndex * 90 + row * scale + vertical;
          const pixelColumn = 40 + letterIndex * 6 * scale + column * scale + horizontal;
          pixels[pixelRow * (width + 1) + 1 + pixelColumn] = 0;
        }
      }
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  await writeFile(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]));
}

export function resultText(result: unknown): string {
  return (result as { content: { type: string; text?: string }[] }).content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}
