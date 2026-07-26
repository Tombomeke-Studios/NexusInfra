import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Preferences } from './Preferences';
import { ToastProvider } from '../components/Toast';
import { getDeploymentDefaults, setDeploymentDefaults } from '../prefs';

function renderPrefs() {
  return render(
    <ToastProvider>
      <Preferences />
    </ToastProvider>
  );
}

describe('Preferences', () => {
  beforeEach(() => localStorage.clear());

  it('persists an edited default on save', async () => {
    renderPrefs();
    // Pick the "Game server" default type, then save.
    await userEvent.click(screen.getByRole('button', { name: 'Game server' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(getDeploymentDefaults().type).toBe('game');
  });

  it('reverts to the built-in defaults on reset', async () => {
    setDeploymentDefaults({ cpu: 95, type: 'game' });
    renderPrefs();
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    const d = getDeploymentDefaults();
    expect(d.cpu).toBe(50);
    expect(d.type).toBe('app');
  });
});
