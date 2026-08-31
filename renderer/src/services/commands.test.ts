import {describe, expect, it, vi} from 'vitest';
import {CommandRegistry, normalizeKeyboardCombo, shortcutConflicts} from './commands';

describe('CommandRegistry', () => {
  it('executes only enabled commands and replaces stale definitions', async () => {
    const run = vi.fn();
    const registry = new CommandRegistry();
    registry.replace([{id: 'save', label: 'Save', group: 'Файл', run}]);
    expect(await registry.execute('save')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    registry.replace([{id: 'save', label: 'Save', group: 'Файл', run, enabled: () => false}]);
    expect(await registry.execute('save')).toBe(false);
  });

  it('normalizes shortcuts and detects conflicts', () => {
    expect(normalizeKeyboardCombo('shift+cmd+s')).toBe('Ctrl+Shift+S');
    expect(shortcutConflicts({save: 'Ctrl+S', snapshot: 'ctrl+s'}).get('Ctrl+S')).toEqual(['save', 'snapshot']);
  });
});
