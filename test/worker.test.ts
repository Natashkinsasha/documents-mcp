import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Extractor } from '../src/extract/runner.js';
import { PathGuard } from '../src/paths.js';
import { tempProject } from './helpers.js';

test('a crashed extraction worker is replaced without rejecting the next file', async (context) => {
  const fixture = await tempProject('worker-recovery');
  const runtime = path.join(fixture.directory, 'runtime'); await mkdir(runtime);
  await writeFile(path.join(runtime, 'extract-worker.cjs'), `const {parentPort}=require('node:worker_threads');const fs=require('node:fs');parentPort.on('message',message=>{if(message.stop){parentPort.close();return;}const text=fs.readFileSync(message.file,'utf8');if(text==='crash')throw new Error('test crash');parentPort.postMessage({id:message.id,result:{parts:[{label:'',text}],partial:false}});});`);
  await writeFile(path.join(fixture.docs, 'crash.txt'), 'crash'); await writeFile(path.join(fixture.docs, 'good.txt'), 'Договор поставки');
  const extractor = new Extractor(new PathGuard(fixture.docs, []), runtime, ['rus'], 1000, 1);
  context.after(async () => { await extractor.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  await assert.rejects(extractor.extract('crash.txt'), /Обработка документа прервана/u);
  assert.equal((await extractor.extract('good.txt')).parts[0]?.text, 'Договор поставки');
});
