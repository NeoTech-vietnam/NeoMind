// Pure text helpers shared by the runtime and the editor UI, so this module must not import Node APIs.

/** A lesson is read by people in the review queue and pasted into every later prompt; full evidence stays in its sources. */
export const maxLessonBodyLength = 800;
const maxExplanation = 400;
/** An AI session's proposal may say a bit more than a generated lesson, but never paste logs or raw output. */
export const maxSessionProposalLength = 1500;

type Reference = { kind: string; path?: string; line?: number; nodeId?: string; command?: string };
export type LessonFinding = { id?: string; criterion: string; explanation: string; references?: Reference[] };

export const clipText = (value: string, max: number) => { const text = value.trim().replace(/\s+/gu, ' '); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };

/** Where a finding points, in the words a reader can follow: `path:line` for source, otherwise the step or command. */
export function referenceLabels(references: Reference[] = []): { files: string[]; other: string[] } {
  const files = new Set<string>(), other = new Set<string>();
  for (const ref of references) {
    if (ref.kind === 'source' && ref.path) files.add(ref.line ? `${ref.path}:${ref.line}` : ref.path);
    else if (ref.kind === 'artifact' && ref.nodeId) other.add(`kết quả bước ${ref.nodeId}`);
    else if (ref.kind === 'check' && ref.command) other.add(`check \`${clipText(ref.command, 80)}\``);
  }
  return { files: [...files].slice(0, 4), other: [...other].slice(0, 3) };
}

/**
 * The lesson a repaired review finding proposes: the criterion it broke, what was wrong and where, in a few lines. The
 * reviewer's raw output and the fix stay in the run (`run:<id>/event:<seq>` in the record's sources).
 */
export function repairLessonBody(input: { runId: string; nodeId?: string | undefined; finding: LessonFinding }): string {
  const { files, other } = referenceLabels(input.finding.references);
  const lines = [`Giữ đúng tiêu chí review: ${clipText(input.finding.criterion, 200)}`, `Vấn đề: ${clipText(input.finding.explanation, maxExplanation)}`,
    `Đã sửa trong run ${input.runId}${input.nodeId ? ` (bước ${input.nodeId})` : ''}.${files.length ? ` File: ${files.join(', ')}` : other.length ? ` Tham chiếu: ${other.join(', ')}` : ''}`];
  const body = lines.join('\n');
  return body.length > maxLessonBodyLength ? `${body.slice(0, maxLessonBodyLength - 1)}…` : body;
}

/** The lesson when the reviewer output naming a finding cannot be found (older journals): still short, still pointing at the run. */
export function fallbackRepairLessonBody(runId: string, findingId: string): string {
  return `Review yêu cầu sửa finding ${clipText(findingId, 80)}\nĐã sửa trong run ${runId}; xem bằng chứng trong run nguồn trước khi duyệt.`;
}

const legacyPattern = /^Review finding corrected in run ([a-z0-9-]+): (\S+)\n\nOriginal review evidence:\n([^\n]*)/;
const stringLiteral = '"(?:[^"\\\\]|\\\\.)*"';
const literal = (text: string, field: string) => {
  const match = new RegExp(`"${field}":(${stringLiteral})`).exec(text);
  if (!match) return undefined;
  try { return JSON.parse(match[1]!) as string; } catch { return undefined; }
};

/** The JSON object starting at `start`, or undefined when the text was cut before it closes. */
function objectAt(text: string, start: number): unknown {
  let depth = 0, quoted = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) { if (char === '\\') index++; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) { try { return JSON.parse(text.slice(start, index + 1)) as unknown; } catch { return undefined; } }
  }
  return undefined;
}

/** The finding in reviewer output that older lessons embedded as JSON, often cut at 5000 characters. */
function legacyFinding(evidence: string, findingId: string): { nodeId?: string; finding: LessonFinding } | undefined {
  let payload: { nodeId?: unknown; evidence?: { findings?: LessonFinding[] } } | undefined;
  try { payload = JSON.parse(evidence) as typeof payload; } catch { payload = undefined; }
  const nodeId = typeof payload?.nodeId === 'string' ? payload.nodeId : literal(evidence.slice(0, 400), 'nodeId');
  const whole = payload?.evidence?.findings?.find(item => item.id === findingId);
  if (whole?.criterion && whole.explanation) return { ...(nodeId ? { nodeId } : {}), finding: whole };
  const start = evidence.indexOf(`{"id":${JSON.stringify(findingId)},"criterion":`);
  if (start < 0) return undefined;
  const parsed = objectAt(evidence, start) as LessonFinding | undefined;
  if (parsed?.criterion && parsed.explanation) return { ...(nodeId ? { nodeId } : {}), finding: parsed };
  // Cut inside this finding: keep the fields that survived and the source references that are complete.
  const rest = evidence.slice(start), next = rest.indexOf('{"id":"', 1), own = next > 0 ? rest.slice(0, next) : rest;
  const criterion = literal(own, 'criterion'), explanation = literal(own, 'explanation');
  if (!criterion || !explanation) return undefined;
  const references = [...own.matchAll(new RegExp(`\\{"kind":"source","path":(${stringLiteral}),"line":(\\d+)`, 'g'))].map(match => ({ kind: 'source', path: JSON.parse(match[1]!) as string, line: Number(match[2]) }));
  return { ...(nodeId ? { nodeId } : {}), finding: { criterion, explanation, references } };
}

/**
 * The short body for a lesson written in the old repair format (`Review finding corrected in run …` with raw reviewer
 * JSON and the agent's whole reply). Undefined when the body is not in that format or the finding cannot be recovered,
 * so nothing else is ever rewritten.
 */
export function compactLegacyLessonBody(body: string): { body: string; runId: string; findingId: string } | undefined {
  const match = legacyPattern.exec(body);
  if (!match) return undefined;
  const [, runId, findingId, evidence] = match as unknown as [string, string, string, string];
  const found = legacyFinding(evidence, findingId);
  if (!found) return undefined;
  return { body: repairLessonBody({ runId, nodeId: found.nodeId, finding: found.finding }), runId, findingId };
}

/** First line as a title and the rest as a preview, for cards that must stay short however long the body is. */
export function memoryTitle(body: string): { title: string; rest: string } {
  const text = body.trim(), newline = text.indexOf('\n'), first = (newline < 0 ? text : text.slice(0, newline)).trim();
  return { title: first.length > 160 ? `${first.slice(0, 159)}…` : first || '(trống)', rest: newline < 0 ? '' : text.slice(newline + 1).trim() };
}

export type BodyPart = { kind: 'text'; text: string } | { kind: 'json'; raw: string; pretty: string | undefined; summary: string };

/**
 * Body text split into prose and JSON blocks (a line that starts with `{` or `[` and is long, like reviewer evidence in
 * old lessons), so the UI can fold the JSON instead of printing thousands of characters in one paragraph.
 */
export function splitBodyParts(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let prose: string[] = [];
  const flush = () => { const text = prose.join('\n').trim(); if (text) parts.push({ kind: 'text', text }); prose = []; };
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length >= 120 && /^[[{]/.test(trimmed)) {
      flush();
      let pretty: string | undefined;
      try { pretty = JSON.stringify(JSON.parse(trimmed), null, 2); } catch { pretty = undefined; }
      parts.push({ kind: 'json', raw: trimmed, pretty, summary: `${pretty ? 'JSON' : 'JSON bị cắt'} · ${trimmed.length.toLocaleString('vi-VN')} ký tự` });
    } else prose.push(line);
  }
  flush();
  return parts;
}

/** Run IDs a record or proposal cites in its sources (`run:<id>` or `run:<id>/…`), for "Mở run nguồn". */
export function sourceRunIds(sources: string[]): string[] {
  return [...new Set(sources.flatMap(source => { const match = /^run:([a-z0-9-]+)(?:\/|$)/.exec(source); return match ? [match[1]!] : []; }))];
}
