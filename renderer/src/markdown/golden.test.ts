import {describe, expect, it} from 'vitest';
import {payloadForSave} from '../services/files';
import {createTab} from '../state/session';
import {containsNonPortableYfm} from './policy';
import {renderMarkdown, sanitizeHtml} from './pipeline';

const files = import.meta.glob('../../../tests/golden/*.md', {eager: true, query: '?raw', import: 'default'}) as Record<string, string>;

describe('golden Markdown corpus', () => {
  for (const [name, markdown] of Object.entries(files)) {
    it(`${name}: untouched bytes and portable semantic rendering`, () => {
      const bytes = new TextEncoder().encode(markdown);
      const tab = createTab(name, markdown);
      expect(payloadForSave(tab, bytes)).toBe(bytes);
      expect(containsNonPortableYfm(markdown)).toBe(false);
      const rendered = renderMarkdown(markdown, 'https://jira.example');
      expect(rendered.html).not.toMatch(/<script|\son[a-z]+=/iu);
      expect(sanitizeHtml(rendered.html)).not.toMatch(/javascript:/iu);
    });
  }

  it('preserves BOM and CRLF bytes for an untouched document', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Заголовок\r\n\r\nТекст\r\n')]);
    const tab = createTab('bom-crlf.md', new TextDecoder().decode(bytes));
    expect(Array.from(payloadForSave(tab, bytes) as Uint8Array)).toEqual(Array.from(bytes));
  });
});
