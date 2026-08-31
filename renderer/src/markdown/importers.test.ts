import {describe, expect, it} from 'vitest';
import {htmlToMarkdown} from './importers';

describe('HTML import', () => {
  it('uses portable GFM and preserves a complex HTML table', () => {
    const result = htmlToMarkdown('<h1>Документ</h1><aside data-alert="WARNING"><p>Осторожно</p></aside><table><tr><td rowspan="2">A</td><td>B</td></tr></table><script>bad()</script>');
    expect(result.markdown).toContain('# Документ');
    expect(result.markdown).toContain('> [!WARNING]');
    expect(result.markdown).toContain('rowspan="2"');
    expect(result.markdown).not.toContain('script');
  });

  it('removes executable HTML and unsafe links before Turndown', () => {
    const result = htmlToMarkdown('<script>alert(1)</script><a href="javascript:alert(2)" onclick="bad()">опасно</a><p style="color:red">текст</p>');
    expect(result.markdown).not.toMatch(/javascript:|onclick|<script/iu);
    expect(result.markdown).toContain('опасно');
    expect(result.losses).toContain('цветовое оформление');
  });
});
