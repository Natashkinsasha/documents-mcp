import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, chunkParts, excerpt, renderChunks, stemWord, tokens } from '../src/index/text.js';
import { Store } from '../src/index/store.js';
import { decodeText, htmlToText, rtfToText } from '../src/extract/text.js';
import { cp1251 } from './helpers.js';

test('Snowball stems Russian inflections, English, case and ё consistently', () => {
  for (const word of ['договора', 'договору', 'ДОГОВОР']) assert.equal(stemWord(word), stemWord('договор'));
  assert.equal(stemWord('поставки'), stemWord('поставка'));
  assert.equal(stemWord('contracts'), stemWord('contract'));
  assert.deepEqual(tokens('ЁЛКА, елка: 123!'), ['елк', 'елк', '123']);
});

test('queries are safe, AND/OR and final-prefix work, filename ranks higher', (context) => {
  const store = new Store(':memory:'); context.after(() => store.close());
  store.put('Договор.txt', 20, 1, 'ok', null, chunkParts([{ label: '', text: 'Поставка насоса.' }]));
  store.put('other.txt', 20, 1, 'ok', null, chunkParts([{ label: '', text: 'Договору поставки насоса.' }]));
  for (const input of ['"', '*', 'NEAR(', ':', '" OR 1=1 --', 'договор " * : NEAR(']) assert.doesNotThrow(() => [...store.search(input, '', 'AND')]);
  assert.equal(buildQuery('договор поставки'), '"договор" AND "поставк"*');
  assert.equal(buildQuery('договор поставки', 'OR'), '"договор" OR "поставк"*');
  assert.equal(buildQuery('"*:'), null);
  assert.equal(buildQuery('код ЛП-0419', 'PHRASE'), '"код" AND "лп 0419"*');
  assert.equal(buildQuery('код ЛП-0419'), '"код" AND "лп" AND "0419"*');
  assert.equal(buildQuery('ЛП-0419 код', 'OR'), '"лп" OR "0419" OR "код"*');
  assert.equal(buildQuery('договор поставки', 'PHRASE'), null);
  assert.equal(buildQuery('договор,поставка', 'PHRASE'), null);
  assert.equal(buildQuery('ставка 4,5', 'PHRASE'), '"ставк" AND "4 5"*');
  assert.equal([...store.search('договор поста', '', 'AND')].length, 2);
  assert.equal([...store.search('договор absent', '', 'AND')].length, 0);
  assert.equal([...store.search('договор absent', '', 'OR')].length, 2);
  assert.equal([...store.search('договора', '', 'AND')][0]?.path, 'Договор.txt');
  assert.equal([...store.search('договор', 'oth', 'AND')].length, 0);
});

test('chunks preserve originals and never cross parts; excerpt locates an inflected word', () => {
  const original = `${'Первая строка\n'.repeat(200)}Договору поставки соответствует цена.\n`;
  const chunks = chunkParts([{ label: 'Страница 1', text: original }, { label: 'Страница 2', text: 'конец' }]);
  assert.equal(chunks.filter((chunk) => chunk.label === 'Страница 1').map((chunk) => chunk.text).join(''), original);
  assert.equal(renderChunks(chunks), `--- Страница 1 ---\n${original}\n\n--- Страница 2 ---\nконец`);
  const snippet = excerpt(original, 'договор');
  assert.match(snippet.text, /Договору/u); assert.ok(snippet.text.startsWith('…')); assert.ok(snippet.text.length < 310);
  assert.equal(original.slice(snippet.start).replace(/\s+/gu, ' ').slice(0, 50), snippet.text.slice(1, 51));
});

test('excerpt prefers a phrase over an earlier lone word and falls back to any word', () => {
  const text = `Серия ЛП снята. ${'Промежуточный текст. '.repeat(30)}Позиция ЛП-0419 на складе.`;
  assert.match(excerpt(text, 'ЛП-0419').text, /ЛП-0419/u);
  assert.match(excerpt('Серия ЛП снята.', 'ЛП-0419').text, /Серия ЛП/u);
});

test('a phrase may end in an unfinished word', (context) => {
  const store = new Store(':memory:'); context.after(() => store.close());
  store.put('a.txt', 1, 1, 'ok', null, [{ seq: 0, label: '', text: 'Позиция ЛП-0419.' }]);
  assert.equal([...store.search('ЛП-04', '', 'PHRASE')].length, 1);
  assert.equal([...store.search('ЛП-05', '', 'AND')].length, 0);
});

test('legacy encoding, UTF-16 BOM, HTML stripping and basic RTF', () => {
  const text = 'Русский договор ёж';
  assert.equal(decodeText(cp1251(text)), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from(text, 'utf16le')])), text);
  const big = Buffer.from(text, 'utf16le'); big.swap16();
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe,0xff]), big])), text);
  assert.equal(decodeText(Buffer.from('\uFEFFПривет')), 'Привет');
  assert.equal(htmlToText('<script>secret</script><style>x</style><p>Договор &amp; цена</p><table><tr><td>Насос</td><td>12500</td></tr></table>'), 'Договор & цена\n\nНасос | 12500 |');
  assert.equal(rtfToText('{\\rtf1{\\fonttbl ignored}Hello\\par World \\u1044?}'), 'Hello\nWorld Д');
});

test('a failed document transaction preserves old text and FTS rows', (context) => {
  const store = new Store(':memory:'); context.after(() => store.close());
  store.put('atomic.txt', 10, 1, 'ok', null, [{ seq: 0, label: '', text: 'Исходный договор' }]);
  assert.throws(() => store.put('atomic.txt', 11, 2, 'ok', null, [{ seq: 0, label: '', text: 'новый' }, { seq: 0, label: '', text: 'повтор' }]));
  assert.equal(store.get('atomic.txt')?.mtime_ms, 1);
  assert.equal(store.chunks('atomic.txt')[0]?.text, 'Исходный договор');
  assert.equal([...store.search('договор', '', 'AND')].length, 1);
  assert.equal([...store.search('повтор', '', 'AND')].length, 0);
});
