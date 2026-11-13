import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../dist/app.js';
import { projectRoot, docx, spreadsheet, textPdf, scannedImage, cp1251, resultText } from '../test/helpers.js';

const directory = path.join(projectRoot, 'tmp', 'sample');
const docs = path.join(directory, 'documents');
await mkdir(docs, { recursive: true });
await writeFile(path.join(docs, 'Договор.txt'), 'Договор поставки оборудования № 42.\nПоставка насоса — 12500 рублей.\nОплата по договору в течение 30 дней.\n');
await writeFile(path.join(docs, 'Условия.txt'), cp1251('Условия договора поставки: доставка со склада в течение пяти дней.'));
await docx(path.join(docs, 'Поставка.docx'));
await spreadsheet(path.join(docs, 'Цены.xlsx'));
await textPdf(path.join(docs, 'Contract.pdf'));
await scannedImage(path.join(docs, 'Scan.png'));
const config = await loadConfig({ DOCS_ROOT: docs, INDEX_DIR: path.join(directory, 'index'), MCP_TOKEN: 'sample-local-only-'.repeat(4), OCR_LANGS: 'eng' });
config.port = 0;
const app = await createApp(config);
const client = new Client({ name: 'sample-client', version: '1.0.0' });
try {
  await app.start();
  await app.indexer.rescan();
  const address = app.http.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP address');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
  const output: string[] = [];
  for (const request of [
    { name: 'search_documents', arguments: { query: 'договор поставки' } },
    { name: 'list_folder', arguments: {} },
    { name: 'read_document', arguments: { path: 'Поставка.docx' } },
    { name: 'documents_status', arguments: {} },
    { name: 'read_document', arguments: { path: 'Scan.png' } },
    { name: 'read_document', arguments: { path: 'Цены.xlsx' } },
    { name: 'read_document', arguments: { path: 'Contract.pdf' } },
  ]) {
    const result = await client.callTool(request);
    output.push(`=== ${request.name} ${JSON.stringify(request.arguments)} ===\n${resultText(result)}`);
    if (result.isError) throw new Error(`Sample tool failed: ${request.name}: ${resultText(result)}`);
  }
  const report = output.join('\n\n');
  await writeFile(path.join(directory, 'sample-report.txt'), report);
  console.log(report);
} finally { await client.close(); await app.close(); }
