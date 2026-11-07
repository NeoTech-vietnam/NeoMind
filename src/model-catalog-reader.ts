import { readFileSync } from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';

/** Read the user's VS Code JSONC without rewriting it or exposing source in errors. */
export function readModelCatalog(path: string): unknown {
  let source: string;
  try { source = readFileSync(path, 'utf8').replace(/^\uFEFF/, ''); }
  catch { throw new Error('VS Code language model catalog is unavailable.'); }
  const errors: ParseError[] = [];
  const catalog: unknown = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error('VS Code language model catalog contains invalid JSONC syntax.');
  return catalog;
}
