import { VERSION } from '../src/version.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevationArguments, launchWindowsWizard, runWizard, wizardMode, type WizardDependencies } from '../src/wizard.js';
import { printConnection, type InstallOptions } from '../src/install.js';
import { upgradeSettings } from '../src/install.js';
import { defaultPaths } from '../src/config.js';
import { windowsAdministrator, type execute } from '../src/service.js';

const settings = { DOCS_ROOT: 'C:\\Документы', MCP_TOKEN: 'a'.repeat(64), TUNNEL_TOKEN: 'hidden-tunnel-token', PUBLIC_URL: 'https://vs.cuechat.org', PORT: '3000' };

function fixture(answers: string[] = [], installed = true) {
  const output: string[] = []; const questions: string[] = []; const installs: InstallOptions[] = []; const purges: boolean[] = []; const copied: string[] = [];
  const io = { print: (line: string) => output.push(line), ask: async (question: string) => { questions.push(question); return answers.shift() ?? ''; } };
  const dependencies: WizardDependencies = {
    io, status: async () => ({ installed, settings, version: '1.0.0', taskState: 'Running' }),
    installer: async (options) => { installs.push(options); const next = upgradeSettings(settings, options, defaultPaths('win32')); printConnection(next, io.print); return next; },
    uninstaller: async (purge) => { purges.push(purge); },
    picker: async () => 'C:\\Новая папка', clipboard: async (key) => { copied.push(key); },
  };
  return { dependencies, output, questions, installs, purges, copied };
}

test('only an interactive no-argument Windows launch or explicit --wizard enters wizard mode', () => {
  assert.equal(wizardMode([], 'win32', true), true); assert.equal(wizardMode(['--wizard'], 'win32', true), true);
  for (const platform of ['linux', 'darwin'] as const) { assert.equal(wizardMode([], platform, true), false); assert.equal(wizardMode(['--wizard'], platform, true), false); }
  assert.equal(wizardMode([], 'win32', false), false);
  for (const args of [['run'], ['run', '--config', 'C:\\config.env'], ['install'], ['--help'], ['--wizard', '--docs', 'C:\\docs']]) assert.equal(wizardMode(args, 'win32', true), false);
});

test('elevation passes only --wizard and safely quotes spaces, apostrophes, quotes and Cyrillic', () => {
  for (const executable of ['C:\\Program Files\\documents-mcp.exe', "C:\\O'Brien\\documents-mcp.exe", 'C:\\Документы\\файл "новый".exe', "C:\\path'; Write-Host evil; 'x.exe"]) {
    const args = elevationArguments(executable);
    assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-Command']);
    assert.equal(args[2], `$ErrorActionPreference='Stop'; Start-Process -FilePath '${executable.replaceAll("'", "''")}' -ArgumentList '--wizard' -Verb RunAs`);
    assert.ok(!args.join(' ').includes(settings.MCP_TOKEN)); assert.ok(!args.join(' ').includes(settings.TUNNEL_TOKEN));
  }
  assert.throws(() => elevationArguments('bad\npath'));
});

test('elevation checks high integrity SID rather than localized group names', async () => {
  for (const [stdout, expected] of [['Mandatory Label\\High Mandatory Level S-1-16-12288', true], ['SYSTEM S-1-16-16384', true], ['Administrators S-1-5-32-544 S-1-16-8192', false]] as const) {
    const run = (async (file: string, args: string[]) => { assert.equal(file, 'whoami.exe'); assert.deepEqual(args, ['/groups']); return { stdout }; }) as typeof execute;
    assert.equal(await windowsAdministrator(run), expected);
  }
  assert.equal(await windowsAdministrator((async () => { throw new Error(); }) as typeof execute), false);
});

test('fresh wizard selects a folder, installs, prints connection and copies the key, then waits', async () => {
  const state = fixture([], false);
  await runWizard(state.dependencies);
  assert.deepEqual(state.installs, [{ docs: 'C:\\Новая папка', allowRemoteUpdate: false }]); assert.deepEqual(state.copied, [settings.MCP_TOKEN]);
  assert.match(state.output.join('\n'), /Добро пожаловать/u); assert.match(state.output.join('\n'), /Ключ скопирован/u);
  assert.ok(state.output.join('\n').includes(`Ключ для Cue: ${settings.MCP_TOKEN}`));
  assert.match(state.questions[0]!, /SYSTEM.*По умолчанию выключено/u);
  assert.equal(state.questions[1], 'Нажмите Enter, чтобы закрыть окно');
  assert.ok(!state.output.join('\n').includes(settings.TUNNEL_TOKEN));
});

test('wizard upgrade preserves settings and key and shows installed and executable versions', async () => {
  const state = fixture(['1']); await runWizard(state.dependencies);
  assert.deepEqual(state.installs, [{ yes: true }]); assert.deepEqual(state.copied, [settings.MCP_TOKEN]);
  for (const text of ['Установлена версия: 1.0.0', `Версия этого файла: ${VERSION}`, 'Running', settings.DOCS_ROOT, settings.PUBLIC_URL]) assert.ok(state.output.join('\n').includes(text));
});

test('show key copies it without reinstalling or displaying tunnel credentials', async () => {
  const state = fixture(['2']); await runWizard(state.dependencies);
  assert.deepEqual(state.installs, []); assert.deepEqual(state.copied, [settings.MCP_TOKEN]);
  assert.ok(state.output.join('\n').includes(`Ключ для Cue: ${settings.MCP_TOKEN}`)); assert.ok(!state.output.join('\n').includes(settings.TUNNEL_TOKEN));
});

test('change folder preserves key and connection', async () => {
  const state = fixture(['3']); await runWizard(state.dependencies);
  assert.deepEqual(state.installs, [{ docs: 'C:\\Новая папка', yes: true }]); assert.deepEqual(state.copied, [settings.MCP_TOKEN]);
});

test('reconnect asks for a new Cue connection without replacing key or folder', async () => {
  const state = fixture(['4']); await runWizard(state.dependencies);
  assert.deepEqual(state.installs, [{ connection: 'cue', docs: settings.DOCS_ROOT }]); assert.deepEqual(state.copied, [settings.MCP_TOKEN]);
});

for (const purge of [true, false]) test(`uninstall confirms removal and ${purge ? 'purges only after explicit confirmation' : 'keeps settings by default'}`, async () => {
  const state = fixture(['5', 'да', purge ? 'да' : '']); await runWizard(state.dependencies);
  assert.deepEqual(state.purges, [purge]); assert.deepEqual(state.installs, []);
  assert.match(state.questions[2]!, /Сами документы сохранятся/u);
});

test('uninstall cancellation and exit make no changes', async () => {
  for (const answers of [['5', ''], ['0'], ['']]) {
    const state = fixture(answers); await runWizard(state.dependencies);
    assert.deepEqual(state.purges, []); assert.deepEqual(state.installs, []); assert.deepEqual(state.copied, []);
  }
});

test('picker failure and cancel fall back to a typed path', async () => {
  for (const failure of [true, false]) {
    const state = fixture(['C:\\Введённая папка'], false);
    state.dependencies.picker = async () => { if (failure) throw new Error('picker unavailable'); return ''; };
    await runWizard(state.dependencies); assert.deepEqual(state.installs, [{ docs: 'C:\\Введённая папка', allowRemoteUpdate: false }]);
  }
});

test('fresh wizard enables remote update only after explicit consent', async () => {
  const state = fixture(['да'], false); await runWizard(state.dependencies);
  assert.equal(state.installs[0]?.allowRemoteUpdate, true);
});

test('errors stay in Russian without a stack, redact credentials and wait for Enter', async () => {
  const state = fixture(['1']);
  state.dependencies.installer = async () => { throw new Error(`Ошибка установки ${settings.TUNNEL_TOKEN} ABCD-EFGH-JKMN`); };
  await runWizard(state.dependencies);
  assert.match(state.output.join('\n'), /Ошибка установки/u); assert.ok(!state.output.join('\n').includes(settings.TUNNEL_TOKEN));
  assert.ok(!state.output.join('\n').includes('ABCD-EFGH-JKMN')); assert.ok(!state.output.join('\n').includes(' at '));
  assert.equal(state.questions.at(-1), 'Нажмите Enter, чтобы закрыть окно');
});

test('clipboard failure is a warning, with the printed key still available', async () => {
  const state = fixture(['2']); state.dependencies.clipboard = async () => { throw new Error('clip failed'); };
  await runWizard(state.dependencies); assert.match(state.output.join('\n'), /Скопируйте «Ключ для Cue» вручную/u);
});

test('UAC declined shows administrator requirement and waits, successful relaunch exits without waiting', async () => {
  const state = fixture(); let launches = 0;
  await launchWindowsWizard('C:\\Program Files\\Программа.exe', { io: state.dependencies.io, elevated: async () => false, relaunch: async () => { launches++; throw new Error('cancelled'); }, wizard: async () => { assert.fail('not elevated'); } });
  assert.equal(launches, 1); assert.match(state.output.join('\n'), /нужны права администратора/u); assert.equal(state.questions.at(-1), 'Нажмите Enter, чтобы закрыть окно');
  const success = fixture();
  await launchWindowsWizard('C:\\program.exe', { io: success.dependencies.io, elevated: async () => false, relaunch: async (file) => { assert.equal(file, 'C:\\program.exe'); }, wizard: async () => { assert.fail(); } });
  assert.deepEqual(success.questions, []);
  let ran = false;
  await launchWindowsWizard('C:\\program.exe', { io: success.dependencies.io, elevated: async () => true, relaunch: async () => { assert.fail(); }, wizard: async () => { ran = true; } });
  assert.equal(ran, true);
});
