import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { loadConfig, configEnvironment, defaultPaths, readConfigFile } from './config.js';
import { createApp } from './app.js';
import { install, uninstall, printConnection, type InstallOptions } from './install.js';
import { requireAdministrator, serviceAction } from './service.js';
import { log } from './types.js';
import { VERSION } from './version.js';
import { launchWindowsWizard, wizardMode } from './wizard.js';
import { commandError } from './terminal.js';

const HELP = `documents-mcp — поиск и чтение документов через MCP

Команды:
  run                Запустить сервер (команда по умолчанию)
  install            Установить или обновить службу (root/Администратор)
  uninstall          Удалить службу; --purge удаляет также настройки и индекс
  status             Состояние службы и индекса, адрес и ключ
  token              Показать адрес и ключ (root/Администратор)
  --wizard           Мастер установки и управления Windows
  --version          Версия программы
  --help             Эта справка

Настройки:
  --config <путь>     Файл настроек; переменные окружения имеют приоритет
  --docs <путь>       Папка документов для установки
  --cue-address <адрес>  Адрес из Cue, например vs.cuechat.org
  --cue-code <код>    Одноразовый код из Cue (XXXX-XXXX-XXXX, действует 24 часа)
  --tunnel-token <токен>  Свой токен Cloudflare (безопаснее вводить интерактивно)
  --public-url <URL>  Публичный HTTPS-адрес своего туннеля
  --port <число>      Порт (по умолчанию 3000; для адреса Cue задаётся Cue)
  --user <имя>        Пользователь службы Linux; Windows использует SYSTEM
  --yes              Без вопросов; --docs обязателен впервые, без подключения — локально

CUE_URL — адрес кабинета для активации (по умолчанию https://app.cuechat.org).
Для Windows: скачайте exe и откройте двойным щелчком — запустится мастер.
Код и токен туннеля не сохраняются в журнале; безопаснее вводить их по запросу.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  process.umask(0o077);
  if (args[0] === '--') args.shift();
  if (wizardMode(args, process.platform, Boolean(process.stdin.isTTY))) { await launchWindowsWizard(); return; }
  if (args.includes('--help')) { console.log(HELP); return; }
  if (args.includes('--version')) { console.log(`documents-mcp ${VERSION}`); return; }
  let command = 'run';
  if (args[0] && !args[0].startsWith('-')) command = args.shift()!;
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (['--yes', '--purge'].includes(key)) { flags[key] = true; continue; }
    if (!['--config', '--docs', '--cue-address', '--cue-code', '--tunnel-token', '--public-url', '--port', '--user'].includes(key) || args[index + 1] === undefined) throw new Error('Неизвестный параметр или отсутствует значение. Используйте --help.');
    flags[key] = args[++index]!;
  }
  const file = typeof flags['--config'] === 'string' ? flags['--config'] : defaultPaths().config;
  if (['install', 'uninstall'].includes(command) && flags['--config']) throw new Error('Установка и удаление используют стандартный системный файл настроек; --config допустим для run, status и token.');
  if (command === 'install') {
    const options: InstallOptions = { docs: flags['--docs'] as string | undefined, cueAddress: flags['--cue-address'] as string | undefined, cueCode: flags['--cue-code'] as string | undefined, tunnelToken: flags['--tunnel-token'] as string | undefined, publicUrl: flags['--public-url'] as string | undefined, port: flags['--port'] as string | undefined, user: flags['--user'] as string | undefined, yes: Boolean(flags['--yes']) };
    await install(options); return;
  }
  if (command === 'uninstall') { await uninstall(Boolean(flags['--purge'])); return; }
  if (command === 'token') { await requireAdministrator(); printConnection(await readConfigFile(file)); return; }
  if (command === 'status') {
    const settings = await configEnvironment(file, process.env, !flags['--config']);
    const state = await serviceAction('status', defaultPaths()).catch(() => 'не запущена или служба недоступна');
    console.log(`Версия: ${VERSION}\nСлужба: ${state}\nПорт: ${settings.PORT ?? '3000'}\nТуннель: ${settings.TUNNEL_TOKEN ? 'включён' : 'выключен'}`);
    printConnection(settings);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path.join(settings.INDEX_DIR ?? defaultPaths().data, 'index.sqlite'), { readOnly: true });
      const counts = database.prepare('SELECT status, count(*) AS count FROM documents GROUP BY status').all();
      const labels: Record<string, string> = { ok: 'Готово', partial: 'Прочитаны частично', error: 'Ошибки', unsupported: 'Неподдерживаемые' };
      for (const row of counts) console.log(`${labels[String(row.status)] ?? 'Файлы'}: ${String(row.count)}`);
      const latest = database.prepare('SELECT max(indexed_at) AS latest FROM documents').get();
      console.log(`Последняя индексация: ${String(latest?.latest ?? 'ещё не было')}`);
    } catch { console.log('Индекс пока отсутствует или недоступен.'); }
    finally { database?.close(); }
    return;
  }
  if (command !== 'run') throw new Error('Неизвестная команда. Используйте --help.');
  const config = await loadConfig(await configEnvironment(file, process.env, !flags['--config']));
  const app = await createApp(config);
  const stop = () => { void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
  try { await app.start(); }
  catch (error) { await app.close(); throw error; }
}

void main().catch((error: unknown) => {
  const message = commandError(error);
  log({ level: 'error', message }); process.exitCode = 1;
});
