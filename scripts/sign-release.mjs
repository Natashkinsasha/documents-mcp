import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const trust = JSON.parse(await readFile(new URL('../src/update-public-key.json', import.meta.url), 'utf8'));
const pinnedKey = createPublicKey({ key: Buffer.from(trust.spki, 'base64'), format: 'der', type: 'spki' });

export async function signRelease({ directory = path.join(root, 'release'), version, privateKey, publicKey = pinnedKey }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) || !version.split('.').every((part) => Number.isSafeInteger(Number(part)))) throw new Error('Invalid release version');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 key');
  const name = 'documents-mcp-win-x64.exe';
  const file = path.join(directory, name); const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 1024 ** 3) throw new Error('Invalid Windows release asset');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  const bytes = Buffer.from(JSON.stringify({ schema: 1, version, assets: { 'win-x64': { name, size: info.size, sha256: hash.digest('hex') } } }));
  const signature = sign(null, bytes, key);
  if (!verify(null, bytes, publicKey, signature)) throw new Error('Signing key does not match pinned public key');
  const manifest = path.join(directory, 'update-manifest.json'); const detached = `${manifest}.sig`;
  try {
    await writeFile(`${manifest}.tmp`, bytes, { mode: 0o600 });
    await writeFile(`${detached}.tmp`, signature.toString('base64'), { mode: 0o600 });
    await rename(`${detached}.tmp`, detached); await rename(`${manifest}.tmp`, manifest);
  } finally { await rm(`${manifest}.tmp`, { force: true }); await rm(`${detached}.tmp`, { force: true }); }
  return { version, size: info.size };
}
async function main() {
  let privateKey = process.env.DOCUMENTS_MCP_SIGNING_KEY;
  delete process.env.DOCUMENTS_MCP_SIGNING_KEY;
  if (!privateKey) {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 16_384) throw new Error('Key input too large'); chunks.push(chunk); }
    privateKey = Buffer.concat(chunks).toString('utf8');
  }
  if (!privateKey || privateKey.length > 16_384) throw new Error('Missing key');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await signRelease({ privateKey, version });
  console.log(`Signed update-manifest.json for ${version}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Release signing failed. Check the private key, pinned public key and release assets.'); process.exitCode = 1; });
}
