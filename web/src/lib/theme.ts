import { useEffect, useState } from 'react';
import { load, save } from './storage';

export type Theme = 'light' | 'dark';

const systemTheme = (): Theme => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** Follows the OS until the user picks; the pick is stamped on <html data-theme>. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = load('theme');
    return saved === 'light' || saved === 'dark' ? saved : systemTheme();
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    save('theme', next);
  };
  return { theme, toggle };
}
