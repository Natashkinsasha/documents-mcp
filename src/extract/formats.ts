import path from 'node:path';
export const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini', '.rtf', '.html', '.htm']);
export const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);
export function readable(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return textExtensions.has(extension) || imageExtensions.has(extension) || ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.ods', '.pptx'].includes(extension);
}
