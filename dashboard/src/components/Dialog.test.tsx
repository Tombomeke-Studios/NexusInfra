import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DialogProvider, useDialog, type ConfirmOptions, type PromptOptions } from './Dialog';

// In-app dialogs replacing window.confirm / window.prompt (#299). The native
// ones froze the page thread, so no automated run ever reached the other side of
// one; these tests are the first time these paths are exercised at all.

/** Opens one dialog and records whatever it resolves to, so a test can read it. */
function Result({ options, kind }: { options: ConfirmOptions | PromptOptions; kind: 'confirm' | 'prompt' }) {
  return (
    <DialogProvider>
      <Opener options={options} kind={kind} />
    </DialogProvider>
  );
}

function Opener({ options, kind }: { options: ConfirmOptions | PromptOptions; kind: 'confirm' | 'prompt' }) {
  const { confirm, prompt } = useDialog();
  return (
    <>
      <button
        onClick={async () => {
          const answer = kind === 'confirm' ? await confirm(options as ConfirmOptions) : await prompt(options as PromptOptions);
          document.title = JSON.stringify(answer);
        }}
      >
        open
      </button>
      <input aria-label="behind the dialog" />
    </>
  );
}

const open = async () => userEvent.click(screen.getByRole('button', { name: 'open' }));

describe('confirm dialog', () => {
  const OPTIONS: ConfirmOptions = {
    title: 'Delete legacy-svc?',
    message: 'This permanently removes the server and its files.',
    confirmLabel: 'Delete server',
    danger: true,
  };

  it('names what is being acted on, rather than asking in the abstract', async () => {
    render(<Result options={OPTIONS} kind="confirm" />);
    await open();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Delete legacy-svc?');
    expect(screen.getByText(/permanently removes the server/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete server' })).toBeInTheDocument();
  });

  it('resolves true when confirmed', async () => {
    render(<Result options={OPTIONS} kind="confirm" />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Delete server' }));

    expect(document.title).toBe('true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves false when cancelled', async () => {
    render(<Result options={OPTIONS} kind="confirm" />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(document.title).toBe('false');
  });

  it('resolves false on Escape', async () => {
    render(<Result options={OPTIONS} kind="confirm" />);
    await open();
    await userEvent.keyboard('{Escape}');

    expect(document.title).toBe('false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gives a destructive dialog the safe default, so a reflexive Enter cancels', async () => {
    render(<Result options={OPTIONS} kind="confirm" />);
    await open();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('gives a routine dialog its confirm button, since nothing is destroyed', async () => {
    render(<Result options={{ title: 'Restart?', confirmLabel: 'Restart' }} kind="confirm" />);
    await open();
    expect(screen.getByRole('button', { name: 'Restart' })).toHaveFocus();
  });

  it('returns focus to where it was when it closes', async () => {
    // Otherwise a keyboard user is dropped at the top of the document after
    // every confirmation.
    render(<Result options={OPTIONS} kind="confirm" />);
    const opener = screen.getByRole('button', { name: 'open' });
    await open();
    await userEvent.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });
});

describe('prompt dialog', () => {
  const OPTIONS: PromptOptions = {
    title: 'New folder',
    label: 'Folder name',
    confirmLabel: 'Create',
    validate: (value) => (value.trim() ? (/[\\/]/.test(value) ? 'A name cannot contain a slash' : null) : 'A name is required'),
  };

  it('resolves the entered value', async () => {
    render(<Result options={OPTIONS} kind="prompt" />);
    await open();
    await userEvent.type(await screen.findByLabelText('Folder name'), 'config');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(document.title).toBe('"config"');
  });

  it('resolves null when cancelled, exactly as window.prompt did', async () => {
    render(<Result options={OPTIONS} kind="prompt" />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(document.title).toBe('null');
  });

  it('refuses an invalid value and says why, rather than finding out server-side', async () => {
    render(<Result options={OPTIONS} kind="prompt" />);
    await open();
    await userEvent.type(await screen.findByLabelText('Folder name'), 'a/b');

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot contain a slash/i);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    // Nothing resolved: the dialog is still open.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('starts from the value it was given, selected for replacing', async () => {
    render(<Result options={{ ...OPTIONS, title: 'Rename', initialValue: 'old-name' }} kind="prompt" />);
    await open();
    expect(await screen.findByLabelText('Folder name')).toHaveValue('old-name');
  });
});

describe('without a provider', () => {
  it('refuses rather than silently agreeing', async () => {
    // These guard deletions. A missing provider answering "yes" would turn a
    // wiring mistake into destroyed data.
    function Bare() {
      const { confirm, prompt } = useDialog();
      return (
        <button
          onClick={async () => {
            document.title = JSON.stringify([await confirm({ title: 'x' }), await prompt({ title: 'x', label: 'y' })]);
          }}
        >
          open
        </button>
      );
    }
    render(<Bare />);
    await open();
    expect(document.title).toBe('[false,null]');
  });
});
