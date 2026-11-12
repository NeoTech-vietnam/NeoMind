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
    else if (ref.kind === 'artifact' && ref.nodeId) other.add(`output of step ${ref.nodeId}`);
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
  const lines = [`Keep review criterion: ${clipText(input.finding.criterion, 200)}`, `Problem: ${clipText(input.finding.explanation, maxExplanation)}`,
    `Fixed in run ${input.runId}${input.nodeId ? ` (step ${input.nodeId})` : ''}.${files.length ? ` Files: ${files.join(', ')}` : other.length ? ` References: ${other.join(', ')}` : ''}`];
  return clipLesson(lines.join('\n'));
}

const clipLesson = (body: string) => body.length > maxLessonBodyLength ? `${body.slice(0, maxLessonBodyLength - 1)}…` : body;

/** The lesson when the reviewer output naming a finding cannot be found (older journals): still short, still pointing at the run. */
export function fallbackRepairLessonBody(runId: string, findingId: string): string {
  return `Review asked to fix finding ${clipText(findingId, 80)}\nFixed in run ${runId}; check the evidence in the source run before approving.`;
}

type LineRule = [RegExp, (...groups: string[]) => string];
const fromVietnameseReferences = (text: string) => text.replace(/kết quả bước /gu, 'output of step ');
/**
 * Bodies NeoMind generated in Vietnamese before stored memory moved to English: each template is its lines in order and
 * the first `required` must be present. Only the template words change; the criterion, explanation, file list, rule
 * text and the user's own feedback are kept as written.
 */
const vietnameseTemplates: { required: number; lines: LineRule[] }[] = [
  { required: 3, lines: [
    [/^Giữ đúng tiêu chí review: (.*)$/u, criterion => `Keep review criterion: ${criterion}`],
    [/^Vấn đề: (.*)$/u, explanation => `Problem: ${explanation}`],
    [/^Đã sửa trong run ([a-z0-9-]+)( \(bước [^)]*\))?\.(?: File: (.*)| Tham chiếu: (.*))?$/u, (runId, step, files, other) =>
      `Fixed in run ${runId}${step ? step.replace(' (bước ', ' (step ') : ''}.${files ? ` Files: ${files}` : other ? ` References: ${fromVietnameseReferences(other)}` : ''}`]] },
  { required: 2, lines: [
    [/^Review yêu cầu sửa finding (.*)$/u, findingId => `Review asked to fix finding ${findingId}`],
    [/^Đã sửa trong run ([a-z0-9-]+); xem bằng chứng trong run nguồn trước khi duyệt\.$/u, runId => `Fixed in run ${runId}; check the evidence in the source run before approving.`]] },
  { required: 2, lines: [
    [/^Khi lập kế hoạch, người dùng yêu cầu: (.*)$/u, feedback => `When planning, the user asked: ${feedback}`],
    [/^\(Task gốc: (.*)\)$/u, task => `(Original task: ${task})`]] },
  { required: 2, lines: [
    [/^Tuân thủ rule (\S+): (.*)$/u, (ruleId, text) => `Follow rule ${ruleId}: ${text}`],
    [/^Vấn đề reviewer thấy: (.*)$/u, explanation => `Problem the reviewer found: ${explanation}`],
    [/^File: (.*)$/u, files => `Files: ${files}`]] },
  { required: 2, lines: [
    [/^Run bị chặn: (.*)$/u, reason => `Run blocked: ${reason}`],
    [/^\(Task gốc: (.*)\)$/u, task => `(Original task: ${task})`]] },
];

/**
 * The English body for a lesson or proposal NeoMind wrote from a Vietnamese template (repair lessons, plan feedback,
 * violated rules, blocked runs). Undefined unless every line fits one template, so a body a person wrote is never touched.
 */
export function englishTemplateBody(body: string): string | undefined {
  const lines = body.split('\n');
  for (const template of vietnameseTemplates) {
    if (lines.length < template.required || lines.length > template.lines.length) continue;
    const translated: string[] = [];
    for (const [index, line] of lines.entries()) {
      const [pattern, rewrite] = template.lines[index]!, match = pattern.exec(line);
      if (!match) break;
      translated.push(rewrite(...match.slice(1).map(group => group ?? '')));
    }
    if (translated.length === lines.length) return clipLesson(translated.join('\n'));
  }
  return undefined;
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

/** The run and finding an old-format repair lesson names, even when its embedded evidence was cut before the finding. */
export function legacyLessonHeader(body: string): { runId: string; findingId: string } | undefined {
  const match = legacyPattern.exec(body);
  return match ? { runId: match[1]!, findingId: match[2]! } : undefined;
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
