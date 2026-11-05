/**
 * Browsers ignore @property and @font-face inside a shadow root. Tailwind needs the first for shadows, rings and
 * transforms, the bundled fonts need the second, so the Nimbalyst panel registers both on the document once.
 * They only declare custom properties and font faces; nothing on the host page is restyled.
 */
const registered = new Set<string>();

export function documentLevelRules(css: string): string {
  return (css.match(/@property\s+[\w-]+\s*\{[^}]*\}|@font-face\s*\{[^}]*\}/g) ?? []).join('\n');
}

export function registerDocumentRules(id: string, css: string): void {
  const rules = documentLevelRules(css);
  if (registered.has(id) || !rules) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(rules);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  registered.add(id);
}
