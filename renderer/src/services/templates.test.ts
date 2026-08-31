import {describe, expect, it} from 'vitest';
import {DOCUMENT_TEMPLATES, markdownToJiraDescription} from './templates';

describe('legacy templates and Jira description', () => {
  it('keeps all four portable templates', () => {
    expect(DOCUMENT_TEMPLATES.map((item) => item.id)).toEqual(['readme', 'task', 'report', 'api']);
    for (const template of DOCUMENT_TEMPLATES) expect(template.markdown).not.toMatch(/#\||\{%/u);
  });

  it('converts headings, tasks, alerts, code and links to Jira wiki markup', () => {
    const jira = markdownToJiraDescription('# Заголовок\n\n- [x] Готово\n\n> [!NOTE]\n> Текст\n\n```js\nrun();\n```\n\n[Ссылка](https://example.test)');
    expect(jira).toContain('h1. Заголовок');
    expect(jira).toContain('* Готово');
    expect(jira).toContain('bq. Текст');
    expect(jira).toContain('{code:js}');
    expect(jira).toContain('[Ссылка|https://example.test]');
  });
});
