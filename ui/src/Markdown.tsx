/**
 * A small, dependency-free markdown renderer for gate files and run outputs (briefs, outlines, drafts, reviews).
 * It builds React elements (never HTML strings), so file content cannot inject markup. Covers what langflow's
 * workflows write: headings, paragraphs, lists (nested by indent, task boxes), fenced code, block quotes, tables,
 * horizontal rules, and inline code / bold / italic / strike / links. Anything else shows as plain text.
 */
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'hr' }
  | { type: 'table'; head: string[]; align: ('left' | 'right' | 'center' | null)[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] };
type ListItem = { text: string; checked: boolean | null; children: Block[] };

const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const hr = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const bullet = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const tableSep = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = []; let current = '', code = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '|') { current += '|'; i++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { cells.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const indentOf = (line: string) => line.replace(/\t/g, '    ').match(/^ */)![0].length;

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = bullet.exec(lines[start]!)!, base = indentOf(lines[start]!), ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!, match = bullet.exec(line);
    if (match && indentOf(line) === base && /\d/.test(match[2]!) === ordered) {
      let text = match[3]!, checked: boolean | null = null;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) { checked = task[1] !== ' '; text = task[2]!; }
      // Continuation lines and nested lists belong to this item until a line at or left of the bullet.
      const inner: string[] = []; i++;
      while (i < lines.length) {
        const next = lines[i]!;
        if (!next.trim()) { if (i + 1 < lines.length && lines[i + 1]!.trim() && indentOf(lines[i + 1]!) > base) { inner.push(''); i++; continue; } break; }
        if (indentOf(next) <= base && (bullet.test(next) || fence.test(next) || heading.test(next))) break;
        if (indentOf(next) <= base && !inner.length) { text += ` ${next.trim()}`; i++; continue; }
        if (indentOf(next) <= base) break;
        inner.push(next); i++;
      }
      // Indented lines before the first nested list or code block continue the item's text; the rest are nested blocks.
      let split = inner.findIndex(item => bullet.test(item) || fence.test(item));
      if (split < 0) split = inner.length;
      const continuation = inner.slice(0, split).map(item => item.trim()).filter(Boolean), nested = inner.slice(split);
      if (continuation.length) text += ` ${continuation.join(' ')}`;
      const minIndent = nested.length ? Math.min(...nested.filter(item => item.trim()).map(indentOf)) : 0;
      items.push({ text, checked, children: nested.length ? parseBlocks(nested.map(item => item.replace(/\t/g, '    ').slice(Math.min(minIndent, indentOf(item))))) : [] });
      continue;
    }
    break;
  }
  return { block: { type: 'list', ordered, start: ordered ? parseInt(first[2]!, 10) || 1 : 1, items }, next: i };
}

export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const open = fence.exec(line);
    if (open) {
      const marker = open[1]!, body: string[] = []; i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) { body.push(lines[i]!); i++; }
      blocks.push({ type: 'code', lang: open[2] ?? '', text: body.join('\n') }); i++; continue;
    }
    const head = heading.exec(line);
    if (head) { blocks.push({ type: 'heading', level: head[1]!.length, text: head[2]! }); i++; continue; }
    if (hr.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) { body.push(lines[i]!.replace(/^\s{0,3}>\s?/, '')); i++; }
      blocks.push({ type: 'quote', lines: body }); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && tableSep.test(lines[i + 1]!)) {
      const head = splitRow(line), align = splitRow(lines[i + 1]!).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' as const : cell.endsWith(':') ? 'right' as const : cell.startsWith(':') ? 'left' as const : null);
      const rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) { rows.push(splitRow(lines[i]!)); i++; }
      blocks.push({ type: 'table', head, align, rows }); continue;
    }
    if (bullet.test(line)) { const { block, next } = parseList(lines, i); blocks.push(block); i = next; continue; }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !fence.test(lines[i]!) && !heading.test(lines[i]!) && !hr.test(lines[i]!) && !/^\s{0,3}>/.test(lines[i]!) && !(body.length && bullet.test(lines[i]!))
      && !(lines[i]!.includes('|') && i + 1 < lines.length && tableSep.test(lines[i + 1]!))) { body.push(lines[i]!); i++; }
    if (!body.length) { body.push(line); i++; }
    blocks.push({ type: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

const safeHref = (href: string) => /^(https?:|mailto:|#)/i.test(href.trim()) ? href.trim() : null;

/** Inline markup: `code`, **bold**, *italic*, ~~strike~~, [text](url), <https://…>; a hard line break on "  \n". */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|(?<![\w])_([^\s_][\s\S]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|( {2,}|\\)\n/g;
  let last = 0, match: RegExpExecArray | null, n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${n++}`;
    if (match[1]) out.push(<code key={key} className="rounded bg-code px-1 py-px font-mono text-[0.92em]">{match[2]!.trim()}</code>);
    else if (match[3] ?? match[4]) out.push(<strong key={key}>{renderInline(match[3] ?? match[4]!, key)}</strong>);
    else if (match[5]) out.push(<del key={key}>{renderInline(match[5], key)}</del>);
    else if (match[6] ?? match[7]) out.push(<em key={key}>{renderInline(match[6] ?? match[7]!, key)}</em>);
    else if (match[8]) {
      const href = safeHref(match[9]!);
      out.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-foreground underline">{renderInline(match[8], key)}</a> : <span key={key} className="underline decoration-dotted" title={match[9]}>{renderInline(match[8], key)}</span>);
    } else if (match[10]) out.push(<a key={key} href={match[10]} target="_blank" rel="noreferrer noopener" className="text-foreground underline">{match[10]}</a>);
    else out.push(<br key={key} />);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const headingClass = ['text-[17px] mt-4', 'text-[15.5px] mt-4', 'text-[14px] mt-3', 'text-[13px] mt-3', 'text-[12.5px] mt-2', 'text-[12.5px] mt-2 text-muted-foreground'];

function BlockView({ block, id }: { block: Block; id: string }) {
  switch (block.type) {
    case 'heading': { const Tag = `h${block.level}` as 'h1'; return <Tag className={cn('mb-1.5 font-semibold leading-snug first:mt-0', headingClass[block.level - 1])}>{renderInline(block.text, id)}</Tag>; }
    case 'paragraph': return <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{renderInline(block.text, id)}</p>;
    case 'code': return <pre className="my-2 overflow-auto whitespace-pre rounded-md bg-code p-2.5 font-mono text-[11.5px] leading-relaxed">{block.text}</pre>;
    case 'hr': return <hr className="my-3 border-0 border-t" />;
    case 'quote': return <blockquote className="my-2 border-0 border-l-[3px] border-solid border-border pl-3 text-fg-2">{parseBlocks(block.lines).map((child, index) => <BlockView key={index} block={child} id={`${id}-${index}`} />)}</blockquote>;
    case 'table': return <div className="my-2 overflow-auto"><table className="border-collapse text-[12px]">
      <thead><tr>{block.head.map((cell, index) => <th key={index} className="border bg-muted px-2 py-1 text-left font-semibold" style={block.align[index] ? { textAlign: block.align[index]! } : undefined}>{renderInline(cell, `${id}-h${index}`)}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, r) => <tr key={r}>{block.head.map((_, c) => <td key={c} className="border px-2 py-1 align-top" style={block.align[c] ? { textAlign: block.align[c]! } : undefined}>{renderInline(row[c] ?? '', `${id}-${r}-${c}`)}</td>)}</tr>)}</tbody>
    </table></div>;
    case 'list': {
      const items = block.items.map((item, index) => <li key={index} className={cn('my-0.5 leading-relaxed', item.checked !== null && 'list-none')}>
        {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly disabled className="mr-1.5 size-3 align-[-1px] accent-primary" />}
        {renderInline(item.text, `${id}-${index}`)}
        {item.children.map((child, c) => <BlockView key={c} block={child} id={`${id}-${index}-${c}`} />)}</li>);
      return block.ordered ? <ol start={block.start} className="my-2 list-decimal pl-5">{items}</ol> : <ul className="my-2 list-disc pl-5">{items}</ul>;
    }
  }
}

/** Renders markdown text as React elements. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'));
  return <div className={cn('text-[12.5px] text-foreground', className)}>{blocks.map((block, index) => <Fragment key={index}><BlockView block={block} id={`b${index}`} /></Fragment>)}</div>;
}
