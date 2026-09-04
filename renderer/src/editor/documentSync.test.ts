import {describe, expect, it} from 'vitest';
import {DocumentSync} from './documentSync';

describe('Gravity source synchronization', () => {
  it('ignores normalization and restores exact source after undo', () => {
    const original = '# Title\r\n\r\n| A  | B  |\r\n|----|----|\r\n| 1  | 2  |\r\n';
    const normalized = '# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n';
    const sync = new DocumentSync(original);
    sync.reset(original, normalized, 'wysiwyg');
    expect(sync.change(normalized, 'wysiwyg')).toBeNull();
    expect(sync.source).toBe(original);
    expect(sync.change(`${normalized}edit`, 'wysiwyg')).toBe(`${normalized}edit`);
    expect(sync.change(normalized, 'wysiwyg')).toBe(original);
  });

  it('retains intentional whitespace edits in source mode', () => {
    const sync = new DocumentSync('# A\n');
    sync.reset('# A\n', '# A\n', 'markup');
    expect(sync.change('# A\n\n', 'markup')).toBe('# A\n\n');
    sync.reset(sync.source, '# A\n', 'wysiwyg');
    expect(sync.change('# A\n', 'wysiwyg')).toBeNull();
    expect(sync.source).toBe('# A\n\n');
  });
});
