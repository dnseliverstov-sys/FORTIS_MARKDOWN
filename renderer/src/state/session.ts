import type {AppSettings, DocumentTab, FortisSession} from '../types';

export const SESSION_KEY = 'fortis.session';
export const AUTOSAVE_KEY = 'fortis.autosave';
export const EXIT_KEY = 'fortis.exit';

export const DEMO_MARKDOWN = `# Руководство по FORTIS

Редактор переведён на **@gravity-ui/markdown-editor**. Документы сохраняются в переносимом GFM.

> [!TIP]
> Переключайтесь между визуальным режимом, разметкой и режимом «Рядом».

## Возможности

- [x] WYSIWYG на ProseMirror
- [x] Markdown на CodeMirror
- [x] Формулы $E = mc^2$
- [x] Диаграммы Mermaid
- [ ] Откройте свой проект и продолжайте работу

| Элемент | Формат |
| --- | --- |
| Таблицы | GFM или переносимый HTML |
| Заметки | GitHub alerts |

\`\`\`mermaid
flowchart LR
  Markdown --> FORTIS --> PDF
\`\`\`
`;

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  new: 'Ctrl+N',
  open: 'Ctrl+O',
  openWorkspace: 'Ctrl+Shift+O',
  save: 'Ctrl+S',
  saveAs: 'Ctrl+Shift+S',
  close: 'Ctrl+W',
  find: 'Ctrl+F',
  workspaceFind: 'Ctrl+Shift+F',
  snapshot: 'Ctrl+Shift+H',
  source: 'Ctrl+E',
  split: 'Ctrl+Shift+E',
  tree: 'Ctrl+B',
  docPanel: 'Ctrl+J',
  recent: 'Ctrl+R',
  themes: 'Ctrl+Shift+P',
  export: 'Ctrl+Shift+X',
  import: 'Ctrl+Shift+I',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  template: 'Ctrl+Shift+N',
  diff: 'Ctrl+D',
  fullscreen: 'F11',
};

export const DEFAULT_TOOLBAR_COMMANDS = [
  'new', 'template', 'open', 'openWorkspace', 'save', 'undo', 'redo', 'find', 'diff', 'snapshot',
  'alert', 'math', 'mermaid', 'table', 'import', 'export', 'bookmark',
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'nocturne',
  viewMode: 'wysiwyg',
  menuVisible: true,
  toolbarVisible: true,
  treeVisible: true,
  docPanelVisible: true,
  docPanel: 'toc',
  spellcheck: false,
  jiraBase: 'https://jira.company.local',
  bitbucketBase: 'https://bitbucket.company.local/projects/DOCS/repos/docs',
  treeWidth: 246,
  panelWidth: 268,
  shortcuts: DEFAULT_SHORTCUTS,
  toolbarCommands: DEFAULT_TOOLBAR_COMMANDS,
  syncScroll: true,
  zoom: 1,
};

export function createTab(name = 'Без имени.md', markdown = '', dirty = false): DocumentTab {
  return {
    id: crypto.randomUUID(),
    name,
    markdown,
    savedMarkdown: markdown,
    dirty,
    touched: dirty,
    revision: 0,
  };
}

function legacyTab(value: Record<string, unknown>, index: number): DocumentTab {
  const markdown = typeof value.md === 'string' ? value.md : '';
  const id = legacyTabId(value.id, index);
  const dirty = Boolean(value.dirty);
  return {
    id,
    name: typeof value.name === 'string' ? value.name : `Документ ${index + 1}.md`,
    markdown,
    savedMarkdown: typeof value.savedMarkdown === 'string' ? value.savedMarkdown : dirty ? '' : markdown,
    dirty,
    touched: dirty,
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : undefined,
    handleKey: typeof value.handleKey === 'string' ? value.handleKey : undefined,
    revision: 0,
  };
}

function legacyTabId(value: unknown, index = 0): string {
  return typeof value === 'string' ? value : `legacy-${String(value ?? index)}`;
}

const LEGACY_COMMAND_IDS: Record<string, string> = {
  openws: 'openWorkspace',
  saveas: 'saveAs',
  closetab: 'close',
  wsfind: 'workspaceFind',
  docpanel: 'docPanel',
  exportdoc: 'export',
  importdoc: 'import',
  jirasetup: 'settings',
  jiradesc: 'jiraDescription',
  zoomin: 'zoomIn',
  zoomout: 'zoomOut',
  zoomreset: 'zoomReset',
  togglemenu: 'toggleMenu',
  toggletb: 'toggleToolbar',
  tbconfig: 'toolbar',
  spell: 'spellcheck',
  syncscroll: 'syncScroll',
  selectall: 'selectAll',
};

function migrateCommandIds<T>(value: unknown, mapValue: (entry: unknown) => T | undefined): Record<string, T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, T> = {};
  for (const [legacyId, entry] of Object.entries(value as Record<string, unknown>)) {
    const converted = mapValue(entry);
    if (converted !== undefined) result[LEGACY_COMMAND_IDS[legacyId] || legacyId] = converted;
  }
  return result;
}

function migrateToolbarIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TOOLBAR_COMMANDS];
  return value
    .filter((id): id is string => typeof id === 'string')
    .map((id) => LEGACY_COMMAND_IDS[id] || id);
}

export function migrateSession(input: unknown): FortisSession {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (raw.version === 2 && Array.isArray(raw.tabs) && raw.settings && typeof raw.settings === 'object') {
    const tabs = raw.tabs.map((value, index) => {
      const tab = value as Partial<DocumentTab>;
      const markdown = typeof tab.markdown === 'string' ? tab.markdown : '';
      return {
        ...createTab(tab.name || `Документ ${index + 1}.md`, markdown),
        ...tab,
        markdown,
        savedMarkdown: typeof tab.savedMarkdown === 'string' ? tab.savedMarkdown : markdown,
        dirty: Boolean(tab.dirty),
        touched: Boolean(tab.touched),
        revision: Number(tab.revision) || 0,
      };
    });
    const settings = {...DEFAULT_SETTINGS, ...(raw.settings as Partial<AppSettings>)};
    settings.shortcuts = {...DEFAULT_SHORTCUTS, ...migrateCommandIds(settings.shortcuts, (entry) => typeof entry === 'string' ? entry : undefined)};
    settings.toolbarCommands = migrateToolbarIds(settings.toolbarCommands);
    settings.syncScroll = settings.syncScroll !== false;
    settings.zoom = Math.max(0.5, Math.min(2, Number(settings.zoom) || 1));
    return {
      version: 2,
      tabs: tabs.length ? tabs : [createTab('Руководство.md', DEMO_MARKDOWN)],
      activeId: typeof raw.activeId === 'string' ? raw.activeId : tabs[0]?.id || null,
      settings,
      recent: Array.isArray(raw.recent) ? raw.recent as FortisSession['recent'] : [],
      bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks as FortisSession['bookmarks'] : [],
    };
  }

  const oldTabs = Array.isArray(raw.tabs) ? raw.tabs.map((value, index) => legacyTab(value as Record<string, unknown>, index)) : [];
  const tabs = oldTabs.length ? oldTabs : [createTab('Руководство.md', DEMO_MARKDOWN)];
  const oldMode = raw.mode === 'markup' || raw.mode === 'split' ? raw.mode : 'wysiwyg';
  const activeLegacy = raw.active == null ? null : legacyTabId(raw.active);
  return {
    version: 2,
    tabs,
    activeId: tabs.some((tab) => tab.id === activeLegacy) ? activeLegacy : tabs[0].id,
    settings: {
      ...DEFAULT_SETTINGS,
      viewMode: oldMode,
      theme: typeof raw.theme === 'string' ? raw.theme : DEFAULT_SETTINGS.theme,
      menuVisible: raw.menuVisible !== false,
      toolbarVisible: raw.toolbarVisible !== false,
      treeVisible: raw.treeVisible !== false,
      docPanelVisible: raw.docPanelVisible !== false,
      spellcheck: Boolean(raw.spell),
      jiraBase: typeof raw.jiraBase === 'string' ? raw.jiraBase : DEFAULT_SETTINGS.jiraBase,
      bitbucketBase: typeof raw.bbBase === 'string' ? raw.bbBase : DEFAULT_SETTINGS.bitbucketBase,
      treeWidth: typeof raw.treeW === 'number' ? raw.treeW : DEFAULT_SETTINGS.treeWidth,
      panelWidth: typeof raw.docW === 'number' ? raw.docW : DEFAULT_SETTINGS.panelWidth,
      shortcuts: {...DEFAULT_SHORTCUTS, ...migrateCommandIds(raw.keys, (entry) => typeof entry === 'string' ? entry : undefined)},
      toolbarCommands: migrateToolbarIds(raw.tbIds),
      syncScroll: raw.syncScroll !== false,
      zoom: Math.max(0.5, Math.min(2, Number(raw.zoom) || 1)),
    },
    recent: Array.isArray(raw.recent) ? raw.recent as FortisSession['recent'] : [],
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks as FortisSession['bookmarks'] : [],
  };
}

export function loadSession(): FortisSession {
  try {
    return migrateSession(JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'));
  } catch {
    return migrateSession(null);
  }
}

export function persistSession(session: FortisSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function applyUserDocumentChange(tab: DocumentTab, markdown: string): DocumentTab {
  return {...tab, markdown, touched: true, dirty: markdown !== tab.savedMarkdown};
}

export function markDocumentSaved(tab: DocumentTab, savedAt = Date.now()): DocumentTab {
  return {...tab, savedMarkdown: tab.markdown, dirty: false, touched: false, savedAt};
}
