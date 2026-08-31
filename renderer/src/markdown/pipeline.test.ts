import {describe, expect, it} from 'vitest';
import {buildExportHtml, renderMarkdown, sanitizeHtml} from './pipeline';

describe('portable markdown pipeline', () => {
  it('renders GFM alerts, Jira keys, tasks and formulas without producing YFM markup', () => {
    const markdown = `# Проверка\n\n> [!NOTE]\n> Важно для DOCS-42\n\n- [x] Готово\n\n$E=mc^2$\n`;
    const result = renderMarkdown(markdown, 'https://jira.example');
    expect(result.html).toContain('data-alert="NOTE"');
    expect(result.html).toContain('https://jira.example/browse/DOCS-42');
    expect(result.html).toContain('katex');
    expect(markdown).not.toMatch(/#\||\{%/);
    expect(result.headings[0].title).toBe('Проверка');
  });

  it('removes executable HTML but retains portable table attributes', () => {
    const clean = sanitizeHtml('<table><tr><td rowspan="2" style="width:30%;background:url(javascript:bad)" onclick="bad()">A</td></tr></table><p width="9" style="color:red">B</p><script>alert(1)</script>');
    expect(clean).toContain('rowspan="2"');
    expect(clean).not.toContain('background');
    expect(clean).not.toContain('<p width=');
    expect(clean).not.toContain('color:red');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('<script');
  });

  it('builds self-contained HTML with inlined fonts, diagrams and relative images', async () => {
    const html = await buildExportHtml('![Схема](images/a.png)\n\n$E=mc^2$', 'Тест', {
      assetResolver: {resolve: async (source) => source === 'images/a.png' ? 'data:image/png;base64,AA==' : null},
    });
    expect(html).toContain('data:image/png;base64,AA==');
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).toContain('katex');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<(?:img|script|link)\b[^>]*(?:src|href)=["']https?:/iu);
    expect(html).not.toMatch(/url\(["']?https?:/iu);
  });

  it('keeps only table layout CSS from user HTML and drops active or global styling', () => {
    const clean = sanitizeHtml('<style>body{display:none}</style><div style="color:red">x</div><table style="width:75%;background:url(https://bad)"><tr><td rowspan="2" style="text-align:center;color:red" onclick="bad()">ok</td></tr></table>');
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('color:red');
    expect(clean).not.toContain('url(');
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('style="width:75%"');
    expect(clean).toContain('rowspan="2"');
    expect(clean).toContain('style="text-align:center"');
  });
});
