import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const docs = path.join(root, 'tmp', 'sample', 'documents');
const reportPath = path.join(root, 'tmp', 'docker-report.txt');
const image = process.argv[2] ?? 'documents-mcp:local-test';
const name = `documents-mcp-verification-${randomBytes(5).toString('hex')}`;
let started = false;
const lines = [];
async function docker(args, timeout = 20_000) {
  return (await execute('docker', args, { timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
}
try {
  await mkdir(docs, { recursive: true });
  await docker([
    'run', '--detach', '--name', name, '--read-only', '--init', '--tmpfs', '/tmp:rw,size=512m,mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=bind,source=${docs},target=/documents,readonly`, '--volume', '/data',
    '--env', `MCP_TOKEN=${randomBytes(32).toString('hex')}`, image,
  ], 30_000);
  started = true;
  lines.push(`Image: ${image}`);
  lines.push(`Health: ${await docker(['exec', name, 'node', '-e', "(async()=>{for(let attempt=0;attempt<50;attempt++){try{const response=await fetch('http://127.0.0.1:3000/healthz');if(response.status===200){console.log(response.status+' '+await response.text());return}}catch{}await new Promise(resolve=>setTimeout(resolve,100))}process.exit(1)})()"] )}`);
  lines.push(`Runtime UID: ${await docker(['exec', name, 'node', '-e', 'console.log(process.getuid())'])}`);
  lines.push(`Node: ${await docker(['exec', name, 'node', '--version'])}`);
  lines.push(`Bundled OCR data: ${await docker(['exec', name, 'node', '-e', "const fs=require('node:fs');const path=require('node:path');const root='/data/runtime';const runtime=fs.readdirSync(root)[0];console.log(fs.readdirSync(path.join(root,runtime,'lang')).join(', '))"])}`);
  lines.push(`Authentication: ${await docker(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:3000/mcp',{method:'POST'}).then(response=>{console.log(response.status);if(response.status!==401)process.exit(1)})"])}`);
  lines.push(`Read-only mounts: ${await docker(['exec', name, 'node', '-e', "const fs=require('node:fs');for(const target of ['/app/write-proof','/documents/write-proof']){try{fs.writeFileSync(target,'no');process.exit(1)}catch(error){if(!['EROFS','EACCES'].includes(error.code))process.exit(1)}}console.log('root filesystem and documents deny writes')"])}`);
  const inspect = JSON.parse(await docker(['inspect', name]))[0];
  if (inspect.HostConfig.ReadonlyRootfs !== true || inspect.HostConfig.CapDrop?.includes('ALL') !== true) throw new Error('Container hardening missing');
  if (inspect.NetworkSettings.Ports?.['3000/tcp'] !== null) throw new Error('Unexpected published port');
  lines.push('Published ports: none');
  lines.push('Capabilities: all dropped; no-new-privileges enabled');
} finally {
  if (started) {
    await docker(['rm', '--force', '--volumes', name]);
    lines.push('Cleanup: verification container and anonymous data volume removed');
  }
  await writeFile(reportPath, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}
