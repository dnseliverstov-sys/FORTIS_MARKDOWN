import {describe, expect, it} from 'vitest';
import {createTab} from '../state/session';
import {payloadForSave} from './files';

describe('byte-exact save payload', () => {
  it('returns original bytes for an untouched file, including BOM and CRLF', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20, 0xd0, 0xa2, 0x0d, 0x0a]);
    const tab = createTab('exact.md', '# Т\r\n');
    expect(payloadForSave(tab, bytes)).toBe(bytes);
  });

  it('returns normalized editor text after a user mutation', () => {
    const tab = {...createTab('edited.md', '# A\r\n'), markdown: '# B\n', touched: true, dirty: true};
    expect(payloadForSave(tab, new Uint8Array([1, 2, 3]))).toBe('# B\n');
  });
});
