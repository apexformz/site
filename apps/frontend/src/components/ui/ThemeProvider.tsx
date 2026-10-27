'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';
const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void }>({
  theme: 'light',
  toggleTheme: () => {},
});

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    const current =
      document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    setTheme(current);
    applyTheme(current);
    const syncTheme = (event: StorageEvent) => {
      if (event.key !== 'apexformz-theme') return;
      const next = event.newValue === 'dark' ? 'dark' : 'light';
      setTheme(next);
      applyTheme(next);
    };
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, []);
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem('apexformz-theme', next);
    } catch {
      /* Theme still works when storage is unavailable. */
    }
  };
  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useContext(ThemeContext);
  const label =
    theme === 'light' ? 'Switch to night theme' : 'Switch to day theme';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`theme-toggle ${compact ? 'theme-toggle-compact' : ''}`}
      aria-label={label}
      title={label}
    >
      <span className={`theme-choice ${theme === 'light' ? 'is-active' : ''}`}>
        <Sun size={18} strokeWidth={1.7} />
      </span>
      <span className={`theme-choice ${theme === 'dark' ? 'is-active' : ''}`}>
        <Moon size={17} strokeWidth={1.7} />
      </span>
    </button>
  );
}
