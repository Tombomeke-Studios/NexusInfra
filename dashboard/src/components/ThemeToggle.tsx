import { useState } from 'react';
import { getTheme, setTheme, type Theme } from '../theme';
import { IconSun, IconMoon } from './Icons';

// Toggles light/dark and persists the choice. Labelled for screen readers since
// it's icon-only.
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme());

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  };

  return (
    <button
      className="icon-btn"
      onClick={toggle}
      data-magnetic
      data-ripple
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title="Toggle theme"
    >
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}
