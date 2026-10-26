/** Explicit unfinished-content markers, not a ban on discussing their names. */
export function hasUnfinishedCornellProse(value: string): boolean {
  if (/\blorem\s+ipsum\b/i.test(value)) return true;
  // These reserved template forms must be expanded before publishing research.
  if (/\{\{[^{}\r\n]+\}\}|<(?:TODO|TBD|placeholder|insert here|fill in)(?:[ :][^<>\r\n]*)?>|\[(?:TODO|TBD|placeholder|insert here|fill in)(?:[ :][^\]\r\n]*)?\]/i.test(value)) return true;
  return value.split(/\r?\n/).some(line => {
    const content = line.trim().replace(/^(?:(?:#{1,6}|[-+*>]|\d+[.)]|\/\/|\/\*|\*)\s*)+/, '').trim()
      .replace(/^`+/, '').replace(/`+$/, '');
    // Recognize unfinished headings, list items and code comments while allowing
    // complete sentences such as "The validator detects TODO markers".
    if (/^(?:TODO|TBD)\b(?:\s*[:=]|\s+(?:add|complete|document|expand|explain|fill|finish|implement|insert|replace|write)\b)/i.test(content)) return true;
    return /^(?:[\p{L}][\p{L}\p{N} _/-]{0,64}:\s*)?(?:TODO|TBD|placeholder(?:\s+(?:text|content|answer|description))?|insert here|fill in)[\s.!]*$/iu.test(content);
  });
}

/** Render only classifications explicitly supplied at the start of prose lines. */
export function renderCornellClaimLabels(value: string): string {
  let fence: { marker: string; width: number } | undefined;
  return value.split(/(?<=\n)/).map(line => {
    const body = line.replace(/\r?\n$/, '');
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body)?.[1];
      if (closing?.charAt(0) === fence.marker && closing.length >= fence.width) fence = undefined;
      return line;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (opening && !(opening[1]!.charAt(0) === '`' && opening[2]!.includes('`'))) {
      fence = { marker: opening[1]!.charAt(0), width: opening[1]!.length };
      return line;
    }
    // Four-space and tab-indented lines are literal code. Inline code cannot
    // begin with this unquoted classification prefix and is never rewritten.
    return line.replace(/^( {0,3})(observed|source-reported|expected|inferred):(?=[ \t\r\n]|$)/i,
      (_match, indentation: string, label: string) => `${indentation}[${label.toLowerCase()}]`);
  }).join('');
}
