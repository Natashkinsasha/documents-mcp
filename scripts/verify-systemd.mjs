import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'documents-mcp-systemd-test';
const lines = [];
const docker = async (args) => (await execute('docker', args, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const inside = (args) => docker(['exec', name, ...args]);
async function waitForActive() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await inside(['systemctl', 'is-active', 'documents-mcp']).catch(() => '') === 'active') return;
    await delay(250);
  }
  throw new Error('Service did not become active');
}
try {
  if (!process.argv.includes('--reuse')) await docker(['run', '-d', '--name', name, '--platform', 'linux/arm64', '--privileged', '--cgroupns=host', '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '-v', `${path.join(root, 'release/documents-mcp-linux-arm64')}:/download/documents-mcp:ro`, '-v', `${path.join(root, 'tmp/verification/linux-arm64/documents')}:/documents:ro`, 'documents-mcp:systemd']);
  await inside(['/download/documents-mcp', 'install', '--yes', '--docs', '/documents']);
  await waitForActive();
  const tokenBefore = await inside(['/usr/local/bin/documents-mcp', 'token']);
  lines.push('install --yes --docs /documents -> success, local health confirmed');
  await inside(['/download/documents-mcp', 'install', '--yes']);
  assert.equal(await inside(['/usr/local/bin/documents-mcp', 'token']), tokenBefore); lines.push('Upgrade preserved the exact saved token and connection settings.');
  const permissions = await inside(['stat', '-c', '%a:%U', '/etc/documents-mcp/config.env']); assert.equal(permissions, '600:documents-mcp'); lines.push(`Config permissions: ${permissions}`);
  const before = await inside(['systemctl', 'show', '-p', 'MainPID', '--value', 'documents-mcp']);
  await inside(['systemctl', 'kill', '--kill-who=main', '--signal=KILL', 'documents-mcp']);
  let after = before;
  for (let attempt = 0; attempt < 80; attempt++) {
    after = await inside(['systemctl', 'show', '-p', 'MainPID', '--value', 'documents-mcp']);
    if (after !== before && Number(after) > 0) break;
    await delay(250);
  }
  assert.ok(Number(after) > 0 && after !== before); lines.push(`SIGKILL restart: MainPID ${before} -> ${after}, NRestarts=${await inside(['systemctl', 'show', '-p', 'NRestarts', '--value', 'documents-mcp'])}`);
  await docker(['restart', name]); await waitForActive(); lines.push('Container/systemd reboot: enabled service started automatically without login.');
  const health = await inside(['bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/3000; printf "GET /healthz HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n" >&3; cat <&3']); assert.match(health, /HTTP\/1\.1 200/u); lines.push(health);
  for (let attempt = 0; attempt < 40; attempt++) { const status = await inside(['/usr/local/bin/documents-mcp', 'status']); if (status.includes('Готово: 6')) break; await delay(250); }
  lines.push(await inside(['/usr/local/bin/documents-mcp', 'status']));
  const unit = await inside(['cat', '/etc/systemd/system/documents-mcp.service']); await writeFile(path.join(root, 'tmp/verification/documents-mcp.service'), unit + '\n'); lines.push(unit);
  lines.push(await inside(['/usr/local/bin/documents-mcp', 'uninstall']));
  await inside(['test', '-f', '/etc/documents-mcp/config.env']); await inside(['test', '-f', '/var/lib/documents-mcp/index.sqlite']); await inside(['test', '!', '-e', '/usr/local/bin/documents-mcp']);
  lines.push('Uninstall removed executable and service; config and index retained.');
  await inside(['/download/documents-mcp', 'install', '--yes']); assert.equal(await inside(['/usr/local/bin/documents-mcp', 'token']), tokenBefore);
  lines.push(await inside(['/usr/local/bin/documents-mcp', 'uninstall', '--purge'])); await inside(['test', '!', '-e', '/etc/documents-mcp/config.env']); await inside(['test', '!', '-e', '/var/lib/documents-mcp']); lines.push('Purge removed config and data; source documents remain.');
  await inside(['test', '-f', '/documents/Скан.png']);
} catch (error) {
  lines.push(`FAILED: ${String(error)}`); lines.push(await inside(['journalctl', '-u', 'documents-mcp', '--no-pager', '-n', '80']).catch(() => 'Journal unavailable')); throw error;
} finally {
  await docker(['rm', '-f', name]).catch(() => {}); lines.push('Cleanup: systemd container removed.');
  await writeFile(path.join(root, 'tmp/verification/systemd-report.txt'), lines.join('\n\n') + '\n'); console.log(lines.join('\n\n'));
}
