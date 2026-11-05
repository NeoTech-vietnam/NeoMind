import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';
/** `web` follows the OS until the user picks a theme; `host` follows the page around the app (the Nimbalyst panel). */
export type ThemeSource = 'web' | 'host';

const storageKey = 'neomind.theme';
const ThemeContext = createContext<{ theme: Theme; source: ThemeSource; setTheme(theme: Theme): void }>({ theme: 'dark', source: 'web', setTheme() {} });
export const useTheme = () => useContext(ThemeContext);

/**
 * The host page's theme. Nimbalyst marks it on <html> (`dark-theme`/`light-theme` class, `data-theme` with the theme
 * id); custom themes have arbitrary ids, so the page background's brightness decides when the markers say nothing.
 */
export function hostTheme(): Theme {
  const html = document.documentElement, hint = `${html.className} ${document.body.className} ${html.dataset.theme ?? ''}`;
  if (/\bdark\b|-dark\b/i.test(hint)) return 'dark';
  if (/\blight\b|-light\b/i.test(hint)) return 'light';
  const channels = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number);
  if (channels && channels.length >= 3 && (channels.length < 4 || channels[3]! > 0)) return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]! < 128 ? 'dark' : 'light';
  return osTheme();
}
const osTheme = (): Theme => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const storedTheme = (): Theme | null => { try { const value = localStorage.getItem(storageKey); return value === 'dark' || value === 'light' ? value : null; } catch { return null; } };

export function ThemeProvider({ source, children }: { source: ThemeSource; children: ReactNode }) {
  const [chosen, setChosen] = useState<Theme | null>(() => source === 'web' ? storedTheme() : null);
  const [detected, setDetected] = useState<Theme>(() => source === 'host' ? hostTheme() : osTheme());
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One theme switch in Nimbalyst fires 20-30 mutations (class, data-theme, swapped stylesheets): settle first.
    const update = () => { clearTimeout(timer); timer = setTimeout(() => setDetected(source === 'host' ? hostTheme() : osTheme()), 80); };
    media.addEventListener('change', update);
    const observer = new MutationObserver(update);
    if (source === 'host') {
      for (const target of [document.documentElement, document.body]) observer.observe(target, { attributes: true });
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    }
    return () => { clearTimeout(timer); observer.disconnect(); media.removeEventListener('change', update); };
  }, [source]);
  const theme = chosen ?? detected;
  const setTheme = (next: Theme) => {
    setChosen(next);
    // Inside Nimbalyst the choice lasts for the session only; the host theme stays the default next time.
    if (source === 'web') try { localStorage.setItem(storageKey, next); } catch { /* storage may be unavailable */ }
  };
  return <ThemeContext.Provider value={{ theme, source, setTheme }}>{children}</ThemeContext.Provider>;
}
