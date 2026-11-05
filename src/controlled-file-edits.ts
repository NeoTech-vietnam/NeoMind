export interface ControlledFileEdit { old_text: string; new_text: string }
export class ControlledFileEditError extends Error {}

/** Resolve small literal edits in memory before the ordinary scoped CAS commit.
 * Reads expose LF-normalized text; matching accepts that representation while
 * untouched bytes and the target's newline convention remain unchanged. */
export function applyControlledFileEdits(current: string, edits: readonly ControlledFileEdit[]): string {
  let result = current;
  for (const edit of edits) {
    const old = edit.old_text.replace(/\r\n/g, '\n'), normalized = result.replace(/\r\n/g, '\n');
    if (!old) throw new ControlledFileEditError('Each edit needs nonempty old_text from the current file.');
    const start = normalized.indexOf(old);
    if (start < 0 || normalized.indexOf(old, start + 1) >= 0)
      throw new ControlledFileEditError('Each old_text must match exactly once. Read the file and include enough surrounding text; no edits were saved.');
    function rawOffset(offset: number): number {
      let raw = 0, text = 0;
      while (text < offset) { if (result[raw] === '\r' && result[raw + 1] === '\n') raw++; raw++; text++; }
      return raw;
    }
    const rawStart = rawOffset(start), rawEnd = rawOffset(start + old.length);
    const newline = result.indexOf('\n'), crlf = newline > 0 && result[newline - 1] === '\r';
    const replacement = crlf ? edit.new_text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : edit.new_text;
    result = result.slice(0, rawStart) + replacement + result.slice(rawEnd);
  }
  return result;
}
