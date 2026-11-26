import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { useSaveShortcut } from './useSaveShortcut';

function press(init: KeyboardEventInit = { key: 's', ctrlKey: true }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function Page({ onSave, enabled }: { onSave: (value: string) => void; enabled: boolean }) {
  const [value, setValue] = useState('');
  const [draft, setDraft] = useState('');
  useSaveShortcut(() => onSave(value), enabled);
  // This field commits its value on blur, as several screens' number fields do.
  return <input aria-label="Rate" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setValue(draft)} />;
}

describe('useSaveShortcut', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('Ctrl+S and Cmd+S run the save and stop the browser save dialog', async () => {
    const onSave = vi.fn();
    render(<Page onSave={onSave} enabled />);
    expect(press().defaultPrevented).toBe(true);
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    press({ key: 's', metaKey: true });
    await flush();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('saves the value a field commits on blur, as a click on Save would', async () => {
    const onSave = vi.fn();
    render(<Page onSave={onSave} enabled />);
    const input = screen.getByLabelText('Rate');
    input.focus();
    fireEvent.change(input, { target: { value: '12.5' } });
    press();
    await flush();
    expect(onSave).toHaveBeenCalledWith('12.5');
  });

  it('does nothing (but still blocks the browser dialog) while Save is disabled', async () => {
    const onSave = vi.fn();
    render(<Page onSave={onSave} enabled={false} />);
    expect(press().defaultPrevented).toBe(true);
    await flush();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('never acts behind an open dialog, on a held key, or on other key combinations', async () => {
    const onSave = vi.fn();
    render(<Page onSave={onSave} enabled />);
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    press();
    await flush();
    dialog.remove();
    press({ key: 's', ctrlKey: true, repeat: true });
    press({ key: 's', ctrlKey: true, shiftKey: true });
    press({ key: 's' });
    await flush();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("ignores a press while the last save is still running, then saves again once it finishes", async () => {
    let finish = () => {};
    const onSave = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    render(<Page onSave={onSave} enabled />);
    press();
    await flush();
    press();
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    press();
    await flush();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("does not save after the page has closed", async () => {
    const onSave = vi.fn();
    const { unmount } = render(<Page onSave={onSave} enabled />);
    press();
    unmount();
    await flush();
    expect(onSave).not.toHaveBeenCalled();
  });
});
