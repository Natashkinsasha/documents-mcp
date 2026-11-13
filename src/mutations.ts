import { constants } from 'node:fs';
import { open, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Indexer } from './index/indexer.js';
import { decodeText } from './extract/text.js';
import { createDocx, createXlsx, editable, replaceable, encodeText, modifiedDate } from './write-formats.js';
import { expiresAt, type TrashEntry, type TrashReason } from './trash.js';
import { MAX_TEXT, UserError, type Logger } from './types.js';

const relativePath = z.string().min(1).max(1000);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u).refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const writeSchemas = {
  create_folder: z.object({ path: relativePath }).strict(),
  write_document: z.object({ path: relativePath, content: z.string().max(MAX_TEXT), overwrite: z.boolean().default(false), expected_modified: timestamp.optional(), replace_office: z.boolean().default(false) }).strict(),
  edit_document: z.object({ path: relativePath, expected_modified: timestamp, edits: z.array(z.object({ old_text: z.string().min(1).max(MAX_TEXT), new_text: z.string().max(MAX_TEXT), replace_all: z.boolean().default(false) }).strict()).min(1).max(50) }).strict(),
  move_path: z.object({ from: relativePath, to: relativePath, overwrite: z.boolean().default(false) }).strict(),
  delete_path: z.object({ path: relativePath }).strict(),
  list_trash: z.object({}).strict(),
  restore_from_trash: z.object({ id: z.string().regex(/^\d{17}-[a-f0-9]{16}$/u), to: relativePath.optional(), overwrite: z.boolean().default(false) }).strict(),
};
export type WriteToolName = keyof typeof writeSchemas;
export const writeInfo: Record<WriteToolName, { title: string; description: string }> = {
  create_folder: { title: 'Создать папку', description: 'Создаёт папку path относительно корня и недостающие промежуточные папки. Повторный вызов для существующей папки успешен; файл с тем же именем вызывает ошибку. Исключённые, скрытые пути, символические ссылки и изменение корня запрещены.' },
  write_document: { title: 'Создать или заменить документ', description: 'Создаёт файл path из content (до 5 миллионов символов). Текст: txt, md, markdown, csv, tsv, json, xml, yaml, yml, log, ini, html, htm; замена сохраняет кодировку и BOM. DOCX: заголовки #–###, абзацы, списки - и 1., **жирный**, *курсив*, таблицы |. XLSX: CSV/TSV или таблицы |, листы через ## Лист: имя; числа, ISO-даты, проценты типизированы, ширины подобраны; жирная шапка и закрепление не поддерживаются. Замена требует overwrite=true и expected_modified из read_document/list_folder. Для существующих DOCX/XLSX ещё нужен replace_office=true: прежнее оформление ТЕРЯЕТСЯ. Перед заменой старая версия сохраняется в корзине на 30 дней. Другие форматы нельзя записывать. Сначала прочитайте документ; при конфликте перечитайте.' },
  edit_document: { title: 'Изменить текст документа', description: 'Точечно изменяет только текстовые форматы. Сначала прочитайте файл. path — относительный путь, expected_modified — точное время изменения ISO с миллисекундами из read_document/list_folder. edits — 1–50 замен old_text на new_text по порядку. old_text непустой и должен встретиться ровно один раз; replace_all=true заменяет все совпадения (хотя бы одно обязательно). CRLF/LF при поиске равнозначны, исходный стиль строк, кодировка и BOM сохраняются. Если любая замена не удалась, файл не меняется. Прежняя версия хранится в корзине 30 дней. DOCX/XLSX можно только заменять через write_document.' },
  move_path: { title: 'Переместить или переименовать', description: 'Перемещает или переименовывает файл любого формата или папку: from и to относительно корня. Родитель to должен существовать. overwrite=false по умолчанию; при true существующая цель сначала отправляется в корзину на 30 дней. Корень, скрытые/исключённые пути и символические ссылки недоступны. Нельзя перемещать папку в себя или заменять её предка. Индекс обновляется сразу.' },
  delete_path: { title: 'Удалить в корзину', description: 'Убирает файл любого формата или папку path со всеми доступными потомками в скрытую корзину. Корень, исключённые пути и символические ссылки запрещены. Возвращает id для restore_from_trash. Хранение — 30 дней, затем автоматическое удаление при обходе. Содержимое корзины не участвует в поиске.' },
  list_trash: { title: 'Корзина', description: 'Без аргументов показывает до 200 последних записей корзины, новые первыми: id, исходный путь, файл/папка, размер в байтах, дата удаления, причина и срок хранения. Причины: удалён, заменён документ, изменён текст, перезаписан перемещением. Для восстановления используйте restore_from_trash; просроченные записи не показываются.' },
  restore_from_trash: { title: 'Восстановить из корзины', description: 'Восстанавливает запись по id из list_trash/delete_path. to — необязательный новый относительный путь, по умолчанию исходный. Недостающие родительские папки создаются. Занятый путь вызывает ошибку, если не передать overwrite=true: тогда текущая версия сама сохраняется в корзину. Корень, скрытые/исключённые пути и символические ссылки запрещены. Запись доступна только 30 дней после удаления, замены или правки. Индекс обновляется сразу.' },
};

export class Mutations {
  constructor(private readonly indexer: Indexer, private readonly logger: Logger) {}

  async call(name: WriteToolName, input: unknown): Promise<string> {
    const fields = input as Record<string, unknown>;
    const paths = ['path', 'from', 'to'].flatMap((key) => typeof fields[key] === 'string' ? [fields[key] as string] : []);
    return this.indexer.exclusive(async () => {
      try {
        let result: { text: string; bytes: number };
        switch (name) {
          case 'create_folder': {
            const args = writeSchemas.create_folder.parse(input);
            await this.indexer.guard.createFolders(args.path);
            result = { text: `Папка создана: ${args.path}`, bytes: 0 }; break;
          }
          case 'write_document': result = await this.write(writeSchemas.write_document.parse(input)); break;
          case 'edit_document': result = await this.edit(writeSchemas.edit_document.parse(input)); break;
          case 'move_path': result = await this.move(writeSchemas.move_path.parse(input)); break;
          case 'delete_path': {
            const args = writeSchemas.delete_path.parse(input);
            const entry = await this.indexer.trash.put(args.path, 'deleted');
            await this.indexer.refresh([entry.originalPath]);
            result = { text: `Удалено в корзину: ${entry.originalPath}\nid: ${entry.id}\nМожно восстановить в течение 30 дней, до ${expiresAt(entry)}.`, bytes: entry.size }; break;
          }
          case 'list_trash': {
            const entries = await this.indexer.trash.list();
            const reasons: Record<TrashReason, string> = { deleted: 'удалён', replaced: 'заменён документ', edited: 'изменён текст', 'overwritten by move': 'перезаписан перемещением' };
            return entries.length ? entries.map((entry) => `id: ${entry.id} | ${entry.originalPath} | ${entry.kind === 'folder' ? 'папка' : 'файл'} | ${entry.size} Б | Удалён: ${entry.deletedAt} | Причина: ${reasons[entry.reason]} | Истекает: ${expiresAt(entry)}`).join('\n') : 'Корзина пуста.';
          }
          case 'restore_from_trash': result = await this.restore(writeSchemas.restore_from_trash.parse(input)); break;
        }
        this.logger({ tool: name, paths, bytes: result.bytes, result: 'ok' });
        return result.text;
      } catch (error) { this.logger({ tool: name, paths, bytes: 0, result: 'error' }); throw error; }
    });
  }

  private checkModified(info: { mtimeMs: number } | undefined, expected?: string): void {
    if (!info || !expected || modifiedDate(info.mtimeMs) !== expected) throw new UserError('Документ изменился или expected_modified не указан. Перечитайте read_document или list_folder и повторите с новым временем изменения.');
  }

  private async original(input: string): Promise<Buffer> {
    const target = await this.indexer.guard.writable(input);
    if (!target.info!.isFile()) throw new UserError('Указанный путь не является файлом.');
    const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (info.ino !== target.info!.ino || info.dev !== target.info!.dev) throw new UserError('Файл изменился во время открытия. Перечитайте документ.');
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  private async atomicWrite(input: string, bytes: Buffer, expected: string | undefined, reason: 'edited' | 'replaced') {
    const guard = this.indexer.guard;
    const target = await guard.writable(input, true);
    const parent = path.posix.dirname(target.relative);
    if (parent !== '.') await guard.writable(parent);
    const resolvedParent = await guard.resolve(parent === '.' ? '' : parent, 'directory');
    if (resolvedParent.absolute !== path.dirname(target.absolute)) throw new UserError('Небезопасная родительская папка.');
    if (target.info) this.checkModified(target.info, expected);
    const temporary = path.join(resolvedParent.absolute, `.documents-mcp-${randomBytes(12).toString('hex')}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, target.info ? target.info.mode & 0o777 : 0o644);
    let backup: TrashEntry | undefined;
    let committed = false;
    try {
      await handle.writeFile(bytes);
      if (target.info) await handle.chmod(target.info.mode & 0o777);
      const mtime = new Date(Math.max(Date.now(), target.info ? Math.floor(target.info.mtimeMs) + 1 : 0));
      await handle.utimes(mtime, mtime);
      await handle.sync();
      await handle.close();
      if (target.info) backup = await this.indexer.trash.put(input, reason, true);
      const current = await guard.writable(input, true);
      if (target.info) {
        this.checkModified(current.info, expected);
        if (current.info!.ino !== target.info.ino || current.info!.mtimeMs !== target.info.mtimeMs || current.info!.size !== target.info.size) throw new UserError('Документ изменился. Перечитайте документ и повторите.');
        await rename(temporary, target.absolute);
      } else {
        if (current.info) throw new UserError('Путь уже существует. Для замены нужны overwrite и expected_modified.');
        await link(temporary, target.absolute);
      }
      committed = true;
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if (backup && !committed) await this.indexer.trash.remove(backup.id);
    }
    await this.indexer.refresh([target.relative]);
    const current = await guard.writable(input);
    return { text: `Документ сохранён: ${target.relative}\nИзменён: ${modifiedDate(current.info!.mtimeMs)}${backup ? `\nПрежняя версия в корзине: ${backup.id} (30 дней).` : ''}`, bytes: bytes.length };
  }

  private async write(args: z.infer<typeof writeSchemas.write_document>) {
    const target = await this.indexer.guard.writable(args.path, true);
    if (!editable(args.path) && !replaceable(args.path)) throw new UserError('Запись доступна только для txt, md, markdown, csv, tsv, json, xml, yaml, yml, log, ini, html, htm, docx и xlsx. Остальные форматы доступны только для чтения, перемещения и удаления.');
    if (target.info) {
      if (!target.info.isFile()) throw new UserError('Путь занят папкой.');
      if (!args.overwrite) throw new UserError('Файл уже существует. Для замены передайте overwrite=true и expected_modified после чтения.');
      this.checkModified(target.info, args.expected_modified);
      if (replaceable(args.path) && !args.replace_office) throw new UserError('Замена DOCX/XLSX теряет прежнее оформление. Подтвердите replace_office=true.');
    }
    const extension = path.extname(args.path).toLowerCase();
    const bytes = extension === '.docx' ? await createDocx(args.content) : extension === '.xlsx' ? createXlsx(args.content) : encodeText(args.content, target.info ? await this.original(args.path) : undefined);
    return this.atomicWrite(args.path, bytes, args.expected_modified, 'replaced');
  }

  private async edit(args: z.infer<typeof writeSchemas.edit_document>) {
    const target = await this.indexer.guard.writable(args.path);
    if (!editable(args.path)) throw new UserError('edit_document работает только с текстовыми форматами; DOCX/XLSX заменяйте целиком через write_document.');
    this.checkModified(target.info, args.expected_modified);
    const original = await this.original(args.path);
    let content = decodeText(original);
    const ending = content.includes('\r\n') ? '\r\n' : content.includes('\r') ? '\r' : '\n';
    content = content.replace(/\r\n?/gu, '\n');
    if (content.length > MAX_TEXT) throw new UserError('Содержимое превышает предел 5 миллионов символов.');
    for (const [index, edit] of args.edits.entries()) {
      const oldText = edit.old_text.replace(/\r\n?/gu, '\n');
      const newText = edit.new_text.replace(/\r\n?/gu, '\n');
      let matches = 0;
      let position = content.indexOf(oldText);
      while (position !== -1) { matches++; position = content.indexOf(oldText, position + 1); }
      if (!matches || !edit.replace_all && matches !== 1) throw new UserError(`Правка ${index + 1}: найдено совпадений ${matches}, требуется ${edit.replace_all ? 'хотя бы одно' : 'ровно одно'}. Ничего не записано; перечитайте документ и уточните old_text.`);
      content = edit.replace_all ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
      if (content.length > MAX_TEXT) throw new UserError(`Правка ${index + 1}: результат превышает 5 миллионов символов. Ничего не записано.`);
    }
    return this.atomicWrite(args.path, encodeText(content.replaceAll('\n', ending), original), args.expected_modified, 'edited');
  }

  private async move(args: z.infer<typeof writeSchemas.move_path>) {
    const guard = this.indexer.guard;
    const source = await guard.writable(args.from);
    const target = await guard.writable(args.to, true);
    if (source.relative === target.relative || target.relative.startsWith(`${source.relative}/`) || source.relative.startsWith(`${target.relative}/`)) throw new UserError('Нельзя перемещать путь в себя, внутрь себя или заменять его предка.');
    const size = await guard.writableTree(args.from, target.relative);
    await guard.resolve(path.posix.dirname(target.relative) === '.' ? '' : path.posix.dirname(target.relative), 'directory');
    let backup: TrashEntry | undefined;
    if (target.info) {
      if (!args.overwrite) throw new UserError('Целевой путь уже существует. Для замены передайте overwrite=true.');
      backup = await this.indexer.trash.put(args.to, 'overwritten by move');
    }
    try {
      await guard.writable(args.from);
      if ((await guard.writable(args.to, true)).info) throw new UserError('Целевой путь уже существует.');
      await rename(source.absolute, target.absolute);
    } catch (error) { if (backup) await this.indexer.trash.restoreItem(backup, target.relative); throw error; }
    await this.indexer.relocate(source.relative, target.relative);
    return { text: `Перемещено: ${source.relative} → ${target.relative}${backup ? `\nПредыдущая цель в корзине: ${backup.id} (30 дней).` : ''}`, bytes: size };
  }

  private async restore(args: z.infer<typeof writeSchemas.restore_from_trash>) {
    const entry = await this.indexer.trash.get(args.id);
    const target = await this.indexer.guard.writable(args.to ?? entry.originalPath, true);
    await this.indexer.trash.validateRestore(entry, target.relative);
    const parent = path.posix.dirname(target.relative);
    if (parent !== '.') await this.indexer.guard.createFolders(parent);
    let backup: TrashEntry | undefined;
    if (target.info) {
      if (!args.overwrite) throw new UserError('Путь восстановления уже существует. Укажите to или overwrite=true.');
      backup = await this.indexer.trash.put(target.relative, 'replaced');
    }
    try { await this.indexer.trash.restoreItem(entry, target.relative); }
    catch (error) { if (backup) await this.indexer.trash.restoreItem(backup, target.relative); throw error; }
    await this.indexer.refresh([target.relative]);
    return { text: `Восстановлено: ${target.relative}${backup ? `\nПредыдущая версия в корзине: ${backup.id} (30 дней).` : ''}`, bytes: entry.size };
  }
}
