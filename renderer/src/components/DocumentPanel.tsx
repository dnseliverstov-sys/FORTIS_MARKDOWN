import {useMemo} from 'react';
import {renderMarkdown} from '../markdown/pipeline';
import type {DocumentPanel as PanelType, DocumentTab, VersionSnapshot} from '../types';

const JIRA_TASKS = [
  {key: 'DOCS-142', title: 'Обновить руководство пользователя', status: 'В работе'},
  {key: 'DOCS-151', title: 'Добавить диаграммы архитектуры', status: 'Открыта'},
  {key: 'FORTIS-37', title: 'Проверить экспорт PDF', status: 'Ревью'},
];

interface Props {
  tab: DocumentTab | null;
  panel: PanelType;
  jiraBase: string;
  versions: VersionSnapshot[];
  onPanel(panel: PanelType): void;
  onInsert(markdown: string): void;
  onRestore(snapshot: VersionSnapshot): void;
  onReveal(href: string): void;
  onOpenRelative(href: string): void;
}

export function DocumentPanel({tab, panel, jiraBase, versions, onPanel, onInsert, onRestore, onReveal, onOpenRelative}: Props) {
  const analysis = useMemo(() => renderMarkdown(tab?.markdown || '', jiraBase), [tab?.markdown, jiraBase]);
  const relative = analysis.links.filter((link) => !link.external && /\.(md|markdown)(?:#.*)?$/i.test(link.href));
  return (
    <aside className="document-panel">
      <div className="panel-tabs">
        {([['toc', 'Оглавление'], ['links', 'Ссылки'], ['files', 'Файлы'], ['versions', 'Версии'], ['jira', 'Jira']] as const).map(([id, label]) => (
          <button key={id} type="button" className={panel === id ? 'active' : ''} onClick={() => onPanel(id)}>{label}</button>
        ))}
      </div>
      <div className="panel-scroll">
        {panel === 'toc' ? analysis.headings.map((heading, index) => (
          <button className="panel-row" style={{paddingLeft: `${10 + (heading.level - 1) * 10}px`}} key={`${heading.href}-${index}`} onClick={() => onReveal(heading.href)}>{heading.title}</button>
        )) : null}
        {panel === 'links' ? analysis.links.map((link, index) => (
          link.external ? <a className="panel-row link-row" href={link.href} key={`${link.href}-${index}`} target="_blank" rel="noreferrer">
            <span>{link.label || link.href}</span><small>{link.href}</small>
          </a> : <button type="button" className="panel-row link-row" key={`${link.href}-${index}`} onClick={() => link.href.startsWith('#') ? onReveal(link.href) : onOpenRelative(link.href)}>
            <span>{link.label || link.href}</span><small>{link.href}</small>
          </button>
        )) : null}
        {panel === 'files' ? relative.map((link, index) => (
          <button type="button" className="panel-row link-row" key={`${link.href}-${index}`} onClick={() => onOpenRelative(link.href)}><span>📄 {link.label}</span><small>{link.href}</small></button>
        )) : null}
        {panel === 'versions' ? versions.map((version) => (
          <button className="panel-row version-row" key={version.ts} onClick={() => onRestore(version)}>
            <span>{version.label}</span><small>{new Date(version.ts).toLocaleTimeString('ru-RU')}</small>
          </button>
        )) : null}
        {panel === 'jira' ? JIRA_TASKS.map((task) => (
          <button className="panel-row jira-row" key={task.key} onClick={() => onInsert(`[${task.key} — ${task.title}](${jiraBase.replace(/\/$/, '')}/browse/${task.key})`)}>
            <strong>{task.key}</strong><span>{task.title}</span><small>{task.status}</small>
          </button>
        )) : null}
        {((panel === 'toc' && !analysis.headings.length) || (panel === 'links' && !analysis.links.length) || (panel === 'files' && !relative.length) || (panel === 'versions' && !versions.length)) ? (
          <div className="empty-panel">Здесь пока ничего нет.</div>
        ) : null}
      </div>
      <div className="panel-stats">{analysis.words} слов · {analysis.characters} знаков · {analysis.lines} строк</div>
    </aside>
  );
}
