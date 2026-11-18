import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import trust from './update-public-key.json' with { type: 'json' };

export const UPDATE_PUBLIC_KEY = trust.spki;
export const UPDATE_ORIGIN = 'https://github.com/Natashkinsasha/documents-mcp/releases/latest/download/';
export const UPDATE_ASSET = 'documents-mcp-win-x64.exe';
export const MAX_UPDATE_SIZE = 1024 * 1024 * 1024;
export const updateKey = () => createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u).refine((value) => value.split('.').every((part) => Number.isSafeInteger(Number(part))));
const manifestSchema = z.object({
  schema: z.literal(1), version,
  assets: z.object({ 'win-x64': z.object({ name: z.literal(UPDATE_ASSET), size: z.number().int().positive().max(MAX_UPDATE_SIZE), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict() }).strict(),
}).strict();
export type UpdateManifest = z.infer<typeof manifestSchema>;
export type UpdateErrorCode = 'disabled' | 'unsupported' | 'network' | 'signature' | 'not_newer' | 'integrity' | 'disk' | 'install' | 'health' | 'interrupted';
export class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode) { super(code); }
}
export function newer(candidate: string, current: string): boolean {
  const next = version.parse(candidate).split('.').map(Number);
  const previous = version.parse(current).split('.').map(Number);
  for (let index = 0; index < 3; index++) if (next[index] !== previous[index]) return next[index]! > previous[index]!;
  return false;
}
export function signedManifest(bytes: Buffer, signature: string, key: KeyObject = updateKey()): UpdateManifest {
  const encoded = signature.trim();
  if (bytes.length > 16_384 || !/^[A-Za-z0-9+/]{86}==$/u.test(encoded) || !verify(null, bytes, key, Buffer.from(encoded, 'base64'))) throw new UpdateError('signature');
  try { return manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new UpdateError('signature'); }
}
export async function verifyUpdateFile(file: string, manifest: UpdateManifest): Promise<void> {
  const asset = manifest.assets['win-x64'];
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { size += (chunk as Buffer).length; if (size > asset.size) throw new UpdateError('integrity'); hash.update(chunk as Buffer); }
  if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new UpdateError('integrity');
}
