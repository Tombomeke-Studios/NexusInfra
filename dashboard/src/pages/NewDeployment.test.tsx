import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { NewDeployment } from './NewDeployment';

// Filling the form and submitting should POST a deployment with the parsed
// ports/env and then navigate to the servers list.
function renderForm() {
  return render(
    <MemoryRouter initialEntries={['/new']}>
      <Routes>
        <Route path="/new" element={<NewDeployment />} />
        <Route path="/servers" element={<div>Servers page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('NewDeployment', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('submits the parsed deployment and navigates to servers', async () => {
    renderForm();

    await userEvent.type(screen.getByLabelText('Name'), 'my-nginx');
    await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
    await userEvent.type(screen.getByLabelText('Ports key 1'), '8080');
    await userEvent.type(screen.getByLabelText('Ports value 1'), '80');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Servers page')).toBeInTheDocument();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/deployments');
    expect(JSON.parse(options.body as string)).toEqual({
      name: 'my-nginx',
      dockerImage: 'nginx',
      ports: { '8080': '80' },
      env: {},
    });
  });

  it('surfaces an API error and stays on the form', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'No healthy node available' }),
    } as Response);
    renderForm();

    await userEvent.type(screen.getByLabelText('Name'), 'svc');
    await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No healthy node available');
  });
});
