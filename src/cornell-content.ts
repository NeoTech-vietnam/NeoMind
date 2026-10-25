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
