export type Status = 'ok' | 'partial' | 'error' | 'unsupported';
export interface Part { label: string; text: string }
export interface Extraction { parts: Part[]; partial: boolean; reason?: string; unsupported?: boolean; ocrDeferred?: boolean }
/** Reason kept on a document whose scanned pages wait for the recognition pass that follows all other documents. */
export const EMPTY_FILE = 'Файл пустой (0 байт): в нём нет содержимого.';
export const OCR_DEFERRED = 'Текст со сканов будет добавлен после обработки остальных документов.';
export interface DocumentRow {
  path: string;
  size: number;
  mtime_ms: number;
  status: Status;
  error: string | null;
  chars: number;
  indexed_at: string;
}
export interface Chunk { seq: number; label: string; text: string }
export type Logger = (entry: Record<string, unknown>) => void;
export const log: Logger = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
export class UserError extends Error {}
export class UnsupportedError extends UserError {}
export const NOT_FOUND = 'Документ или папка не найден(а).';
export const MAX_TEXT = 5_000_000;
