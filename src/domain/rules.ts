import { createHash } from 'node:crypto';

export interface ProjectRule { id: string; text: string }
/** Only these lines are rules; a project keeps headings and blank lines for readability. */
const ruleLine = /^\s*[-*]\s+\[([A-Za-z][A-Za-z0-9._-]{0,31})\]\s+(.+?)\s*$/;

/** Parse `neomind/rules.md`: one `- [R1] text` per rule, codes unique; anything else is skipped with a warning. */
export function parseRules(text: string): { rules: ProjectRule[]; warnings: string[] } {
  const rules: ProjectRule[] = [], warnings: string[] = [], seen = new Set<string>();
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const match = ruleLine.exec(line);
    if (!match) { warnings.push(`Dòng ${index + 1} không đúng dạng "- [R1] nội dung"; bỏ qua.`); return; }
    const id = match[1]!;
    if (seen.has(id)) { warnings.push(`Dòng ${index + 1}: mã ${id} bị trùng; giữ rule đầu tiên.`); return; }
    seen.add(id); rules.push({ id, text: match[2]! });
  });
  return { rules, warnings };
}

export const rulesHash = (rules: ProjectRule[]) => createHash('sha256').update(JSON.stringify(rules)).digest('hex');
export const ruleCriterion = (rule: ProjectRule) => `Rule ${rule.id}: ${rule.text}`;
