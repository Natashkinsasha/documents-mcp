export type Status = 'ok' | 'partial' | 'error' | 'unsupported';
export interface Part { label: string; text: string }
export interface Extraction {
  parts: Part[]; partial: boolean; reason?: string; unsupported?: boolean; ocrDeferred?: boolean;
  /** Pages without a usable text layer. */
  scanPages?: number[];
  /** Recognition stopped between pages to let another file go first; nothing is final yet. */
  yielded?: boolean;
  /** Some pages ran out of recognition time: another run may still get them. */
  retryPages?: boolean;
}
/** Reason kept on a document whose scanned pages wait for the recognition pass that follows all other documents. */
export const EMPTY_FILE = 'Файл пустой (0 байт): в нём нет содержимого.';
export const OCR_DEFERRED = 'Текст со сканов будет добавлен после обработки остальных документов.';
/** Processing that was cut off, not a verdict on the file: these reasons are retried. */
export const INTERRUPTED = 'Обработка документа прервана: ошибка обработчика или предел ресурсов.';
export const OCR_TIMEOUT = 'Превышено время распознавания изображения.';
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
export class InterruptedError extends UserError {}
export const NOT_FOUND = 'Документ или папка не найден(а).';
export const MAX_TEXT = 5_000_000;
