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
    // Pick Postgres as the default engine, then save.
    await userEvent.click(screen.getByRole('button', { name: 'postgres' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(getDeploymentDefaults().dbEngine).toBe('postgres');
  });

  it('reverts to the built-in defaults on reset', async () => {
    setDeploymentDefaults({ cpu: 95, dbEngine: 'mariadb' });
    renderPrefs();
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    const d = getDeploymentDefaults();
    expect(d.cpu).toBe(50);
    expect(d.dbEngine).toBe('mysql');
  });
});
