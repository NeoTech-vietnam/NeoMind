import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Compatibility is a single byte-exact insertion, never a general TOML or
 * configuration exemption. Parsing both candidates rejects fake table headers
 * or required assignments inside multiline strings. */
export function onlyAddedRequiredNeoMindMcp(currentBytes: Buffer, signedOldHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(signedOldHash) || currentBytes.length > 512 * 1024) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(currentBytes), current = parse(text);
    const servers = current.mcp_servers;
    if (!object(servers) || !object(servers.neomind) || !Object.hasOwn(servers.neomind, 'required') || servers.neomind.required !== true) return false;
    // smol-toml uses null-prototype tables. Keep its exact parsed structure;
    // object spreads would manufacture different prototypes and reject a
    // genuine one-line upgrade despite equal TOML values.
    delete servers.neomind.required;
    const expected = current;
    const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
    let selected = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (/^[ \t]*\[.*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)$/.test(line))
        selected = /^[ \t]*\[mcp_servers\.neomind\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)$/.test(line);
      if (!selected || !/^[ \t]*required[ \t]*=[ \t]*true[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)$/.test(line)) continue;
      const candidate = lines.filter((_line, position) => position !== index).join('');
      if (createHash('sha256').update(candidate).digest('hex') === signedOldHash && isDeepStrictEqual(parse(candidate), expected)) return true;
    }
  } catch { /* Ambiguous, malformed or changed input keeps its ordinary hash guard. */ }
  return false;
}
