import {describe, expect, it} from 'vitest';
import {analyzeHtmlImport, htmlToMarkdown} from './importers';

const stateCells = ['RUNNING', 'HOLD', 'INITIATED', 'STARTED', 'FAULT', 'SKIPPED'];

function confluenceFixture(): string {
  const columns = Array.from({length: 15}, (_, index) => `<col style="width:${index + 2}%">`).join('');
  const states = stateCells.map((name) => `<th>${name}</th>`).join('');
  const values = (first = '✅') => stateCells.map((_, index) => `<td style="text-align:center">${index ? '<img class="emoticon" data-emoticon-name="minus" src="https://bad.example/forbidden.svg" alt="(минус)">' : first}</td>`).join('');
  return `<div class="rwui_expandable_item" data-macro-name="ui-expand">
    <a class="rwui_expandable_item_title" onclick="bad()"><div>+</div>Справочник параметров</a>
    <div class="rwui_expandable_item_body"><table class="confluenceTable" style="width:94%"><colgroup>${columns}</colgroup><tbody>
      <tr><th colspan="5" rowspan="2">Поле</th><th rowspan="2">Тип</th><th rowspan="2">Описание</th><th colspan="6">Структура входных параметров в зависимости от состояния</th><th rowspan="2">Свойства</th><th rowspan="2">Правило заполнения параметров</th></tr>
      <tr>${states}</tr>
      <tr><td></td><td colspan="4" data-highlight-colour="#f4f5f7"><span style="color:rgb(0,51,102)">messages</span></td><td>array</td><td>Массив сообщений <img src="https://bad.example/schema.png" alt="Схема"></td>${values()}<td>maxLength: 10</td><td rowspan="3"><div data-macro-name="tip"><div class="confluence-information-macro-body"><ul><li>Первое правило</li><li>Второе правило</li></ul></div></div></td></tr>
      <tr><td></td><td></td><td colspan="3">messages[n]</td><td>object</td><td>Сообщение</td>${values('')}<td></td></tr>
      <tr><td></td><td></td><td></td><td colspan="2">code</td><td>string</td><td>Код сообщения</td>${values()}<td>pattern: a\\|b</td></tr>
    </tbody></table></div>
    <p style="color:red">Служебная подпись</p><img src="https://bad.example/schema.png" alt="Схема"><script>bad()</script>
  </div>`;
}

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

  it('builds exact, portable and readable variants for an anonymized Confluence table', () => {
    const result = analyzeHtmlImport(confluenceFixture());
    expect(result.confluence).toBe(true);
    expect(result.stats).toMatchObject({tables: 1, rows: 5, columns: 15});
    expect(result.stats.mergedCells).toBeGreaterThan(0);

    const exact = result.variants.exact.markdown;
    expect(exact).toContain('<table');
    expect(exact).toContain('<colgroup>');
    expect(exact).toContain('background-color:rgb(244, 245, 247)');
    expect(exact).toContain('color:rgb(0, 51, 102)');
    expect(exact).toContain('class="fortis-table-tip"');
    expect(exact).toContain('<ul>');
    expect(exact).toContain('⛔');
    expect(exact).not.toMatch(/<script|onclick|https:\/\/bad\.example|<img/iu);

    const portable = result.variants.portable.markdown;
    expect(portable).not.toContain('<table');
    expect(portable).toContain('messages[n].code');
    expect(portable).toContain('RUNNING');
    expect(portable).toContain('a\\|b');

    const readable = result.variants.readable.markdown;
    expect(readable).toContain('### Каталог полей');
    expect(readable).toContain('### Матрица состояний');
    expect(readable).toContain('messages[n].code');
    expect(result.variants.exact.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'active-content-removed', 'event-handlers-removed', 'emoticons-normalized', 'images-replaced', 'tip-normalized',
    ]));
  });

  it('falls back to portable GFM in readable mode for an unrecognized table', () => {
    const result = analyzeHtmlImport('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(result.variants.readable.markdown).toContain('| A | B |');
    expect(result.variants.readable.issues.some((item) => item.code === 'readable-fallback')).toBe(true);
  });
});
