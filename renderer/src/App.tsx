import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Button, SegmentedRadioGroup, TextInput, ThemeProvider} from '@gravity-ui/uikit';
import {EditorPane} from './components/EditorPane';
import {WorkspaceTree} from './components/WorkspaceTree';
import {DocumentPanel} from './components/DocumentPanel';
import {Modal} from './components/Modal';
import {TableLab} from './components/TableLab';
import {FormulaPanel, type FormulaEdit} from './components/FormulaPanel';
import {CommandMenu} from './components/CommandMenu';
import type {GravityFormulaTarget} from './editor/gravityBridge';
import {buildExportHtml, markdownToPlainText, renderMarkdown} from './markdown/pipeline';
import {docxToMarkdown, htmlToMarkdown, type ImportResult} from './markdown/importers';
import {
  download, getHandle, inputFile, pickMarkdownFile, pickSaveHandle, pickWorkspace,
  payloadForSave, putHandle, readHandle, walkDirectory, writeHandle,
} from './services/files';
import {CommandRegistry, installCommandShortcuts, keyboardCombo, shortcutConflicts, type FortisCommand} from './services/commands';
import {
  AUTOSAVE_KEY, createTab, DEFAULT_SHORTCUTS, DEFAULT_TOOLBAR_COMMANDS, EXIT_KEY, loadSession, persistSession,
} from './state/session';
import {DOCUMENT_TEMPLATES, markdownToJiraDescription} from './services/templates';
import {applyTheme, THEMES} from './state/themes';
import {diffCount, diffLines} from './utils/diff';
import type {
  DocumentPanel as PanelType, DocumentRuntime, DocumentTab, EditorAdapter, FortisSession,
  VersionSnapshot, ViewMode, WorkspaceNode,
} from './types';

type Dialog = null | 'themes' | 'export' | 'import' | 'settings' | 'diff' | 'recent' | 'shortcuts' | 'table' | 'templates' | 'jiraDescription' | 'toolbar';

interface ImportPreview extends ImportResult {name: string}
interface Recovery {ts: number; tabs: Array<{name: string; md: string}>}
interface Conflict {id: string; name: string; disk: string; bytes: Uint8Array; lastModified: number; added: number; removed: number}

const WORKSPACE_HANDLE_KEY = 'fortis.workspace';
const VERSIONS_KEY = 'fortis.versions.v2';

function loadVersionStore(): Map<string, VersionSnapshot[]> {
  try {
    const value = JSON.parse(localStorage.getItem(VERSIONS_KEY) || '{}') as Record<string, VersionSnapshot[]>;
    return new Map(Object.entries(value).map(([id, list]) => [id, Array.isArray(list) ? list.filter((item) => item && typeof item.markdown === 'string' && typeof item.ts === 'number').slice(0, 25) : []]));
  } catch {
    return new Map();
  }
}

function persistVersionStore(store: Map<string, VersionSnapshot[]>): void {
  try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(Object.fromEntries(store))); } catch { /* localStorage quota */ }
}

function findWorkspaceFile(root: WorkspaceNode | null, href: string): WorkspaceNode | null {
  if (!root) return null;
  let target = href.split('#', 1)[0].replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '');
  try { target = decodeURIComponent(target); } catch { /* keep the literal link */ }
  let match: WorkspaceNode | null = null;
  const visit = (node: WorkspaceNode) => {
    if (match) return;
    const key = node.key.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
    if (node.type === 'file' && (key === target || key.endsWith(`/${target}`) || (!target.includes('/') && node.name === target))) match = node;
    else node.children?.forEach(visit);
  };
  visit(root);
  return match;
}

const TOOLBAR_ICONS: Record<string, string> = {
  new: '＋', template: '▤', open: '📂', openWorkspace: '🗀', save: '💾', saveAs: '↥', close: '×',
  undo: '↶', redo: '↷', find: '⌕', workspaceFind: '⌗', diff: '±', snapshot: '◷',
  alert: 'ⓘ', math: '∑', mermaid: '◇', table: '▦', import: '⇩', export: '⇧', bookmark: '☆',
  source: '</>', split: '◫', tree: '◧', docPanel: '◨', themes: '◉', shortcuts: '⌨', settings: '⚙',
  jiraDescription: 'J', zoomIn: '＋', zoomOut: '−', zoomReset: '1:1', fullscreen: '⛶', toolbar: '☷',
};

function basename(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'документ';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCanceled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function cloneForStorage(session: FortisSession): FortisSession {
  return {...session, tabs: session.tabs.map((tab) => ({...tab}))};
}

function runtimeFor(runtimes: Map<string, DocumentRuntime>, id: string): DocumentRuntime {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const created: DocumentRuntime = {};
  runtimes.set(id, created);
  return created;
}

export default function App() {
  const [session, setSession] = useState<FortisSession>(() => loadSession());
  const sessionRef = useRef(session);
  const [workspace, setWorkspace] = useState<WorkspaceNode | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [workspaceHits, setWorkspaceHits] = useState<Array<{node: WorkspaceNode; line: number; text: string}>>([]);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [closeCandidate, setCloseCandidate] = useState<DocumentTab | null>(null);
  const [exportFormat, setExportFormat] = useState<'html' | 'pdf' | 'txt'>('html');
  const [exportSelection, setExportSelection] = useState(false);
  const [pageSize, setPageSize] = useState('A4');
  const [pageOrientation, setPageOrientation] = useState('portrait');
  const [pageMargin, setPageMargin] = useState(18);
  const [historyTick, setHistoryTick] = useState(0);
  const [formulaEdit, setFormulaEdit] = useState<FormulaEdit | null>(null);
  const [diffTarget, setDiffTarget] = useState('saved');
  const [diffDisk, setDiffDisk] = useState<string | null>(null);
  const adapters = useRef(new Map<string, EditorAdapter>());
  const runtimes = useRef(new Map<string, DocumentRuntime>());
  const versions = useRef(loadVersionStore());
  const toastTimer = useRef<number | null>(null);
  const commandRegistry = useMemo(() => new CommandRegistry(), []);

  useEffect(() => { sessionRef.current = session; }, [session]);
  const activeTab = session.tabs.find((tab) => tab.id === session.activeId) || null;
  const theme = THEMES.find((item) => item.id === session.settings.theme) || THEMES[0];

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const patchTab = useCallback((id: string, patch: Partial<DocumentTab> | ((tab: DocumentTab) => Partial<DocumentTab>)) => {
    setSession((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.id === id ? {...tab, ...(typeof patch === 'function' ? patch(tab) : patch)} : tab),
    }));
  }, []);

  const snapshot = useCallback((id: string, label: string, markdown?: string) => {
    const tab = sessionRef.current.tabs.find((item) => item.id === id);
    const value = markdown ?? tab?.markdown;
    if (value == null) return;
    const list = versions.current.get(id) || [];
    if (list[0]?.markdown === value) return;
    versions.current.set(id, [{ts: Date.now(), label, markdown: value}, ...list].slice(0, 25));
    persistVersionStore(versions.current);
    setHistoryTick((tick) => tick + 1);
  }, []);

  const markUserChange = useCallback((id: string, markdown: string) => {
    patchTab(id, (tab) => ({
      markdown,
      touched: true,
      dirty: markdown !== tab.savedMarkdown,
    }));
  }, [patchTab]);

  const replaceTabMarkdown = useCallback((id: string, markdown: string, touched = true) => {
    patchTab(id, (tab) => ({
      markdown,
      touched: touched || tab.touched,
      dirty: touched ? markdown !== tab.savedMarkdown : tab.dirty,
      revision: tab.revision + 1,
    }));
  }, [patchTab]);

  const addDocument = useCallback((name: string, markdown: string, options: {
    handle?: FileSystemFileHandle | null; sourceFile?: File; bytes?: Uint8Array; lastModified?: number; dirty?: boolean; handleKey?: string;
  } = {}) => {
    const tab = createTab(name, markdown, Boolean(options.dirty));
    tab.savedAt = options.lastModified;
    tab.handleKey = options.handleKey || (options.handle ? `${name}|h` : undefined);
    if (options.dirty) tab.savedMarkdown = '';
    const runtime = runtimeFor(runtimes.current, tab.id);
    if (options.handle) {
      runtime.handle = options.handle;
      if (tab.handleKey) void putHandle(tab.handleKey, options.handle);
    }
    if (options.bytes) runtime.originalBytes = options.bytes;
    if (options.lastModified) runtime.lastModified = options.lastModified;
    const sourceFile = options.sourceFile ? Promise.resolve(options.sourceFile) : options.handle?.getFile();
    if (sourceFile && window.fortisDesktop) {
      void sourceFile.then((file) => window.fortisDesktop?.registerDocument(file)).then((token) => {
        if (token && runtimes.current.has(tab.id)) runtime.assetToken = token;
      }).catch(() => undefined);
    }
    setSession((current) => ({
      ...current,
      tabs: [...current.tabs, tab],
      activeId: tab.id,
      recent: options.handle ? [{key: tab.handleKey!, name, ts: Date.now()}, ...current.recent.filter((item) => item.key !== tab.handleKey)].slice(0, 12) : current.recent,
    }));
    return tab;
  }, []);

  const openFile = useCallback(async () => {
    try {
      const result = await pickMarkdownFile();
      if (!result) return;
      const key = result.handle ? `${result.opened.file.name}|h` : undefined;
      const existing = key && sessionRef.current.tabs.find((tab) => tab.handleKey === key);
      if (existing) { setSession((current) => ({...current, activeId: existing.id})); return; }
      addDocument(result.opened.file.name, result.opened.markdown, {
        handle: result.handle, sourceFile: result.opened.file, bytes: result.opened.bytes, lastModified: result.opened.file.lastModified, handleKey: key,
      });
    } catch (error) {
      if (!isCanceled(error)) notify(`Не удалось открыть файл: ${errorText(error)}`);
    }
  }, [addDocument, notify]);

  const resolveHandle = useCallback(async (tab: DocumentTab): Promise<FileSystemFileHandle | null> => {
    const inMemory = runtimes.current.get(tab.id)?.handle;
    if (inMemory) return inMemory;
    if (!tab.handleKey) return null;
    const restored = await getHandle<FileSystemFileHandle>(tab.handleKey);
    if (restored) {
      const runtime = runtimeFor(runtimes.current, tab.id);
      runtime.handle = restored;
      if (window.fortisDesktop && !runtime.assetToken) {
        void restored.getFile().then((file) => window.fortisDesktop?.registerDocument(file)).then((token) => {
          if (token) runtime.assetToken = token;
        }).catch(() => undefined);
      }
    }
    return restored;
  }, []);

  const saveTab = useCallback(async (id: string, forceSaveAs = false): Promise<boolean> => {
    const tab = sessionRef.current.tabs.find((item) => item.id === id);
    if (!tab) return true;
    try {
      let handle = forceSaveAs ? null : await resolveHandle(tab);
      if (!handle) handle = await pickSaveHandle(tab.name);
      const data = payloadForSave(tab, runtimes.current.get(id)?.originalBytes);
      if (!handle) {
        if (window.showSaveFilePicker) return false;
        download(tab.name, data, 'text/markdown;charset=utf-8');
      } else {
        const file = await writeHandle(handle, data);
        const runtime = runtimeFor(runtimes.current, id);
        runtime.handle = handle;
        runtime.lastModified = file.lastModified;
        if (window.fortisDesktop) {
          void window.fortisDesktop.registerDocument(file).then((token) => {if (token) runtime.assetToken = token;});
        }
      }
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      runtimeFor(runtimes.current, id).originalBytes = bytes;
      const name = handle?.name || tab.name;
      const handleKey = handle ? `${name}|h` : tab.handleKey;
      if (handle && handleKey) void putHandle(handleKey, handle);
      patchTab(id, {
        name, handleKey, savedMarkdown: tab.markdown, dirty: false, touched: false,
        savedAt: Date.now(), revision: tab.revision,
      });
      if (handleKey) setSession((current) => ({
        ...current,
        recent: [{key: handleKey, name, ts: Date.now()}, ...current.recent.filter((item) => item.key !== handleKey)].slice(0, 12),
      }));
      snapshot(id, 'сохранение', tab.markdown);
      notify(`Сохранён «${name}».`);
      return true;
    } catch (error) {
      if (!isCanceled(error)) notify(`Не удалось сохранить: ${errorText(error)}`);
      return false;
    }
  }, [notify, patchTab, resolveHandle, snapshot]);

  const saveAll = useCallback(async (): Promise<boolean> => {
    for (const tab of sessionRef.current.tabs.filter((item) => item.dirty)) {
      setSession((current) => ({...current, activeId: tab.id}));
      if (!(await saveTab(tab.id))) return true;
    }
    return sessionRef.current.tabs.some((tab) => tab.dirty);
  }, [saveTab]);

  const openWorkspace = useCallback(async () => {
    try {
      const selected = await pickWorkspace();
      if (selected) {
        setWorkspace(selected);
        if (selected.handle?.kind === 'directory') void putHandle(WORKSPACE_HANDLE_KEY, selected.handle);
        setSession((current) => ({...current, settings: {...current.settings, treeVisible: true}}));
      }
    } catch (error) {
      if (!isCanceled(error)) notify(`Не удалось открыть папку: ${errorText(error)}`);
    }
  }, [notify]);

  const openWorkspaceNode = useCallback(async (node: WorkspaceNode, line?: number) => {
    if (node.type !== 'file') return;
    try {
      if (node.handle?.kind === 'file') {
        const handle = node.handle as FileSystemFileHandle;
        const opened = await readHandle(handle);
        const key = `workspace:${node.key}`;
        const exists = sessionRef.current.tabs.find((tab) => tab.handleKey === key);
        if (exists) {
          setSession((current) => ({...current, activeId: exists.id}));
          if (line !== undefined) window.setTimeout(() => adapters.current.get(exists.id)?.reveal({line}), 100);
          return;
        }
        const tab = addDocument(node.name, opened.markdown, {handle, sourceFile: opened.file, bytes: opened.bytes, lastModified: opened.file.lastModified, handleKey: key});
        if (line !== undefined) window.setTimeout(() => adapters.current.get(tab.id)?.reveal({line}), 100);
      } else if (node.file) {
        const bytes = new Uint8Array(await node.file.arrayBuffer());
        addDocument(node.name, new TextDecoder().decode(bytes), {sourceFile: node.file, bytes, lastModified: node.file.lastModified});
      }
    } catch (error) {
      notify(`Не удалось открыть «${node.name}»: ${errorText(error)}`);
    }
  }, [addDocument, notify]);

  const openRelativeFile = useCallback((href: string) => {
    const node = findWorkspaceFile(workspace, href);
    if (!node) { notify(`Связанный файл «${href}» не найден в рабочем пространстве.`); return; }
    void openWorkspaceNode(node);
  }, [notify, openWorkspaceNode, workspace]);

  const openRemembered = useCallback(async (key: string, name: string) => {
    const existing = sessionRef.current.tabs.find((tab) => tab.handleKey === key);
    if (existing) { setSession((current) => ({...current, activeId: existing.id})); setDialog(null); return; }
    const handle = await getHandle<FileSystemFileHandle>(key);
    if (!handle) { notify(`Файл «${name}» больше недоступен.`); return; }
    try {
      const opened = await readHandle(handle);
      addDocument(opened.file.name, opened.markdown, {handle, sourceFile: opened.file, bytes: opened.bytes, lastModified: opened.file.lastModified, handleKey: key});
      setDialog(null);
    } catch (error) {
      notify(`Не удалось открыть «${name}»: ${errorText(error)}`);
    }
  }, [addDocument, notify]);

  const closeTab = useCallback((tab: DocumentTab) => {
    if (tab.dirty) { setCloseCandidate(tab); return; }
    setSession((current) => {
      const index = current.tabs.findIndex((item) => item.id === tab.id);
      const tabs = current.tabs.filter((item) => item.id !== tab.id);
      const activeId = current.activeId === tab.id ? tabs[Math.max(0, index - 1)]?.id || tabs[0]?.id || null : current.activeId;
      return {...current, tabs, activeId};
    });
    adapters.current.delete(tab.id);
    runtimes.current.delete(tab.id);
  }, []);

  const setViewMode = useCallback((viewMode: ViewMode) => {
    setSession((current) => ({...current, settings: {...current.settings, viewMode}}));
  }, []);

  const insert = useCallback((markdown: string) => {
    if (!sessionRef.current.activeId) return;
    adapters.current.get(sessionRef.current.activeId)?.insertMarkdown(markdown);
  }, []);

  const applyFindReplace = useCallback((all: boolean) => {
    const tab = sessionRef.current.tabs.find((item) => item.id === sessionRef.current.activeId);
    if (!tab || !findQuery) return;
    const index = tab.markdown.indexOf(findQuery);
    if (index < 0) { notify('Совпадений не найдено.'); return; }
    const markdown = all
      ? tab.markdown.split(findQuery).join(replaceQuery)
      : tab.markdown.slice(0, index) + replaceQuery + tab.markdown.slice(index + findQuery.length);
    replaceTabMarkdown(tab.id, markdown);
    notify(all ? 'Все совпадения заменены.' : 'Совпадение заменено.');
  }, [findQuery, notify, replaceQuery, replaceTabMarkdown]);

  const searchWorkspace = useCallback(async () => {
    if (!workspace || !findQuery) return;
    const files: WorkspaceNode[] = [];
    const visit = (node: WorkspaceNode) => node.type === 'file' ? files.push(node) : node.children?.forEach(visit);
    visit(workspace);
    const hits: typeof workspaceHits = [];
    for (const node of files) {
      try {
        const file = node.handle?.kind === 'file' ? await (node.handle as FileSystemFileHandle).getFile() : node.file;
        if (!file) continue;
        (await file.text()).split(/\r?\n/).forEach((line, index) => {
          if (line.toLocaleLowerCase('ru').includes(findQuery.toLocaleLowerCase('ru'))) hits.push({node, line: index, text: line.trim()});
        });
      } catch { /* inaccessible file is skipped */ }
    }
    setWorkspaceHits(hits.slice(0, 200));
  }, [findQuery, workspace]);

  const importDocument = useCallback(async () => {
    const file = await inputFile('.md,.markdown,.txt,.html,.htm,.docx');
    if (!file) return;
    try {
      const extension = file.name.split('.').pop()?.toLowerCase();
      const result = extension === 'docx'
        ? await docxToMarkdown(await file.arrayBuffer())
        : extension === 'html' || extension === 'htm'
          ? htmlToMarkdown(await file.text())
          : {markdown: await file.text(), losses: []};
      setImportPreview({...result, name: file.name.replace(/\.(docx|html?|txt)$/i, '.md')});
      setDialog('import');
    } catch (error) {
      notify(`Не удалось импортировать: ${errorText(error)}`);
    }
  }, [notify]);

  const openNewFormula = useCallback(() => {
    const id = sessionRef.current.activeId;
    if (!id) return;
    setFormulaEdit({
      tex: '', block: false, existing: false,
      apply: (tex: string, block: boolean) => {adapters.current.get(id)?.execute('insertFormula', {tex, block});},
    });
  }, []);

  const exportDocument = useCallback(async () => {
    const tab = sessionRef.current.tabs.find((item) => item.id === sessionRef.current.activeId);
    if (!tab) return;
    const selection = adapters.current.get(tab.id)?.getSelectionMarkdown() || '';
    const markdown = exportSelection && selection.trim() ? selection : tab.markdown;
    if (exportSelection && !selection.trim()) notify('Ничего не выделено — экспортирован весь документ.');
    const base = basename(tab.name);
    if (exportFormat === 'txt') download(`${base}.txt`, markdownToPlainText(markdown), 'text/plain;charset=utf-8');
    else {
      const html = await buildExportHtml(markdown, base, {
        pageSize, orientation: pageOrientation, marginMm: pageMargin, jiraBase: sessionRef.current.settings.jiraBase,
        assetResolver: runtimes.current.get(tab.id)?.assetToken && window.fortisDesktop ? {
          resolve: (source) => window.fortisDesktop!.readRelativeResource(runtimes.current.get(tab.id)!.assetToken!, source),
        } : undefined,
      });
      if (exportFormat === 'html') download(`${base}.html`, html, 'text/html;charset=utf-8');
      else if (window.fortisDesktop) await window.fortisDesktop.savePdf(html, base);
      else {
        const frame = document.createElement('iframe');
        frame.hidden = true; frame.srcdoc = html; document.body.append(frame);
        frame.onload = () => { frame.contentWindow?.print(); window.setTimeout(() => frame.remove(), 60_000); };
      }
    }
    setDialog(null);
  }, [exportFormat, exportSelection, notify, pageMargin, pageOrientation, pageSize]);

  const toggleBookmark = useCallback(() => {
    const tab = sessionRef.current.tabs.find((item) => item.id === sessionRef.current.activeId);
    if (!tab) return;
    const key = tab.handleKey || `${tab.name}|x`;
    setSession((current) => ({
      ...current,
      bookmarks: current.bookmarks.some((item) => item.key === key)
        ? current.bookmarks.filter((item) => item.key !== key)
        : [...current.bookmarks, {key, name: tab.name}],
    }));
    const handle = runtimes.current.get(tab.id)?.handle;
    if (handle) void putHandle(key, handle);
  }, []);

  const openDiff = useCallback(async () => {
    const tab = sessionRef.current.tabs.find((item) => item.id === sessionRef.current.activeId);
    if (!tab) return;
    let disk: string | null = null;
    try {
      const handle = await resolveHandle(tab);
      if (handle) disk = (await readHandle(handle)).markdown;
    } catch { /* an inaccessible disk version is simply omitted */ }
    setDiffDisk(disk);
    const other = sessionRef.current.tabs.find((item) => item.id !== tab.id);
    setDiffTarget(other?.id || (disk != null ? 'disk' : 'saved'));
    setDialog('diff');
  }, [resolveHandle]);

  useEffect(() => {
    applyTheme(session.settings.theme);
  }, [session.settings.theme]);

  useEffect(() => {
    void getHandle<FileSystemDirectoryHandle>(WORKSPACE_HANDLE_KEY).then(async (handle) => {
      if (!handle || handle.kind !== 'directory') return;
      try {
        setWorkspace({type: 'directory', name: handle.name, key: handle.name, handle, children: await walkDirectory(handle, 0, handle.name)});
      } catch { /* persisted permission may require opening the folder again */ }
    });
  }, []);

  useEffect(() => {
    if (window.fortisDesktop) window.fortisDesktop.setZoomFactor(session.settings.zoom);
    else document.documentElement.style.zoom = String(session.settings.zoom);
  }, [session.settings.zoom]);

  useEffect(() => {
    const openTableEditor = () => setDialog('table');
    window.addEventListener('fortis:edit-table', openTableEditor);
    return () => window.removeEventListener('fortis:edit-table', openTableEditor);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { persistSession(cloneForStorage(session)); } catch { /* localStorage quota */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [session]);

  useEffect(() => {
    let previousClean = true;
    try {
      previousClean = localStorage.getItem(EXIT_KEY) === 'ok';
      const autosave = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null') as Recovery | null;
      if (!previousClean && autosave?.tabs?.length) setRecovery(autosave);
      localStorage.setItem(EXIT_KEY, 'no');
    } catch { /* storage unavailable */ }
    const markClean = () => { try { localStorage.setItem(EXIT_KEY, 'ok'); } catch { /* ignore */ } };
    window.addEventListener('pagehide', markClean);
    return () => window.removeEventListener('pagehide', markClean);
  }, []);

  useEffect(() => {
    const autosave = window.setInterval(() => {
      try {
        const dirty = sessionRef.current.tabs.filter((tab) => tab.dirty);
        if (!dirty.length) localStorage.removeItem(AUTOSAVE_KEY);
        else localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ts: Date.now(), tabs: dirty.map((tab) => ({name: tab.name, md: tab.markdown}))}));
      } catch { /* quota */ }
    }, 2500);
    const snapshots = window.setInterval(() => {
      for (const tab of sessionRef.current.tabs.filter((item) => item.dirty)) snapshot(tab.id, 'автосохранение', tab.markdown);
    }, 180_000);
    return () => { window.clearInterval(autosave); window.clearInterval(snapshots); };
  }, [snapshot]);

  useEffect(() => {
    const poll = window.setInterval(async () => {
      if (conflict || recovery) return;
      for (const tab of sessionRef.current.tabs) {
        const handle = runtimes.current.get(tab.id)?.handle;
        if (!handle) continue;
        try {
          const file = await handle.getFile();
          const runtime = runtimeFor(runtimes.current, tab.id);
          const known = runtime.lastModified;
          if (!known) {runtime.lastModified = file.lastModified; continue;}
          if (file.lastModified <= known) continue;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const disk = new TextDecoder().decode(bytes);
          if (disk !== tab.markdown) setConflict({id: tab.id, name: tab.name, disk, bytes, lastModified: file.lastModified, ...diffCount(tab.markdown, disk)});
          else {
            runtime.lastModified = file.lastModified;
            runtime.originalBytes = bytes;
          }
          break;
        } catch { /* file disappeared */ }
      }
    }, 4000);
    return () => window.clearInterval(poll);
  }, [conflict, recovery]);

  useEffect(() => {
    const controller = new AbortController();
    window.__fortisUnsaved = () => sessionRef.current.tabs.some((tab) => tab.dirty);
    window.__fortisSaveAll = saveAll;
    window.addEventListener('beforeunload', (event) => {
      if (!sessionRef.current.tabs.some((tab) => tab.dirty)) return;
      event.preventDefault();
      event.returnValue = '';
    }, {signal: controller.signal});
    window.addEventListener('dragover', (event) => event.preventDefault(), {signal: controller.signal});
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (!file || !/\.(md|markdown|txt)$/i.test(file.name)) return;
      void file.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        addDocument(file.name, new TextDecoder().decode(bytes), {sourceFile: file, bytes, lastModified: file.lastModified});
      });
    }, {signal: controller.signal});
    return () => {
      controller.abort();
      delete window.__fortisUnsaved;
      delete window.__fortisSaveAll;
    };
  }, [addDocument, saveAll]);

  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<GravityFormulaTarget>).detail;
      setFormulaEdit({
        tex: target.tex,
        block: target.block,
        existing: true,
        apply: (tex: string, block: boolean) => {target.apply(tex, block);},
        remove: () => {target.remove();},
      });
    };
    window.addEventListener('fortis:edit-formula', open);
    return () => window.removeEventListener('fortis:edit-formula', open);
  }, []);

  commandRegistry.replace([
    {id: 'new', label: 'Новый документ', group: 'Файл', run: () => {addDocument('Без имени.md', '', {dirty: true});}},
    {id: 'template', label: 'Новый из шаблона…', group: 'Файл', run: () => setDialog('templates')},
    {id: 'open', label: 'Открыть файл', group: 'Файл', run: openFile},
    {id: 'openWorkspace', label: 'Открыть папку', group: 'Файл', run: openWorkspace},
    {id: 'recent', label: 'Недавние и закладки…', group: 'Файл', run: () => setDialog('recent')},
    {id: 'save', label: 'Сохранить', group: 'Файл', enabled: () => Boolean(activeTab), allowInsideEditor: true, run: () => activeTab ? saveTab(activeTab.id).then(() => undefined) : undefined},
    {id: 'saveAs', label: 'Сохранить как', group: 'Файл', enabled: () => Boolean(activeTab), allowInsideEditor: true, run: () => activeTab ? saveTab(activeTab.id, true).then(() => undefined) : undefined},
    {id: 'bookmark', label: 'В закладки', group: 'Файл', enabled: () => Boolean(activeTab), run: toggleBookmark},
    {id: 'close', label: 'Закрыть вкладку', group: 'Файл', enabled: () => Boolean(activeTab), allowInsideEditor: true, run: () => {if (activeTab) closeTab(activeTab);}},
    {id: 'import', label: 'Импорт', group: 'Файл', run: importDocument},
    {id: 'export', label: 'Экспорт', group: 'Файл', enabled: () => Boolean(activeTab), run: () => setDialog('export')},
    {id: 'jiraDescription', label: 'Описание для Jira…', group: 'Файл', enabled: () => Boolean(activeTab), run: () => setDialog('jiraDescription')},
    {id: 'undo', label: 'Отменить', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {if (activeTab) adapters.current.get(activeTab.id)?.execute('undo');}},
    {id: 'redo', label: 'Повторить', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {if (activeTab) adapters.current.get(activeTab.id)?.execute('redo');}},
    {id: 'cut', label: 'Вырезать', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {document.execCommand('cut');}},
    {id: 'copy', label: 'Копировать', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {document.execCommand('copy');}},
    {id: 'selectAll', label: 'Выделить всё', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {document.execCommand('selectAll');}},
    {id: 'bold', label: 'Полужирный', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {if (activeTab) adapters.current.get(activeTab.id)?.execute('bold');}},
    {id: 'italic', label: 'Курсив', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {if (activeTab) adapters.current.get(activeTab.id)?.execute('italic');}},
    {id: 'strike', label: 'Зачёркнутый', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {if (activeTab) adapters.current.get(activeTab.id)?.execute('strike');}},
    {id: 'find', label: 'Найти и заменить', group: 'Правка', allowInsideEditor: true, run: () => setFindOpen(true)},
    {id: 'workspaceFind', label: 'Поиск в папке', group: 'Правка', run: () => {setFindOpen(true); void searchWorkspace();}},
    {id: 'diff', label: 'Сравнить версии…', group: 'Правка', enabled: () => Boolean(activeTab), run: openDiff},
    {id: 'snapshot', label: 'Создать снимок', group: 'Правка', enabled: () => Boolean(activeTab), run: () => {if (activeTab) snapshot(activeTab.id, 'снимок вручную');}},
    {id: 'source', label: 'Исходный текст', group: 'Вид', run: () => setViewMode(session.settings.viewMode === 'markup' ? 'wysiwyg' : 'markup')},
    {id: 'split', label: 'Режим «Рядом»', group: 'Вид', run: () => setViewMode(session.settings.viewMode === 'split' ? 'wysiwyg' : 'split')},
    {id: 'tree', label: 'Дерево рабочего пространства', group: 'Вид', run: () => setSession((current) => ({...current, settings: {...current.settings, treeVisible: !current.settings.treeVisible}}))},
    {id: 'docPanel', label: 'Панель документа', group: 'Вид', run: () => setSession((current) => ({...current, settings: {...current.settings, docPanelVisible: !current.settings.docPanelVisible}}))},
    {id: 'themes', label: 'Оформление', group: 'Вид', run: () => setDialog('themes')},
    {id: 'spellcheck', label: 'Проверка орфографии', group: 'Вид', run: () => setSession((current) => ({...current, settings: {...current.settings, spellcheck: !current.settings.spellcheck}}))},
    {id: 'syncScroll', label: 'Синхронная прокрутка', group: 'Вид', run: () => setSession((current) => ({...current, settings: {...current.settings, syncScroll: !current.settings.syncScroll}}))},
    {id: 'shortcuts', label: 'Горячие клавиши', group: 'Вид', run: () => setDialog('shortcuts')},
    {id: 'settings', label: 'Адреса Jira и Bitbucket…', group: 'Вид', run: () => setDialog('settings')},
    {id: 'zoomIn', label: 'Увеличить масштаб', group: 'Вид', run: () => setSession((current) => ({...current, settings: {...current.settings, zoom: Math.min(2, Number((current.settings.zoom + 0.1).toFixed(1)))}}))},
    {id: 'zoomOut', label: 'Уменьшить масштаб', group: 'Вид', run: () => setSession((current) => ({...current, settings: {...current.settings, zoom: Math.max(0.5, Number((current.settings.zoom - 0.1).toFixed(1)))}}))},
    {id: 'zoomReset', label: 'Сбросить масштаб', group: 'Вид', run: () => setSession((current) => ({...current, settings: {...current.settings, zoom: 1}}))},
    {id: 'alert', label: 'Блок-заметка', group: 'Вставка', enabled: () => Boolean(activeTab), run: () => insert('> [!NOTE]\n> Текст заметки\n')},
    {id: 'math', label: 'Формула', group: 'Вставка', enabled: () => Boolean(activeTab), run: openNewFormula},
    {id: 'mermaid', label: 'Mermaid', group: 'Вставка', enabled: () => Boolean(activeTab), run: () => insert('```mermaid\nflowchart LR\n  A --> B\n```\n')},
    {id: 'table', label: 'Таблица', group: 'Вставка', enabled: () => Boolean(activeTab), run: () => setDialog('table')},
    {id: 'toggleMenu', label: 'Скрыть/показать главное меню', group: 'Окно', run: () => setSession((current) => ({...current, settings: {...current.settings, menuVisible: !current.settings.menuVisible}}))},
    {id: 'toggleToolbar', label: 'Скрыть/показать панель', group: 'Окно', run: () => setSession((current) => ({...current, settings: {...current.settings, toolbarVisible: !current.settings.toolbarVisible}}))},
    {id: 'toolbar', label: 'Настройка панели…', group: 'Окно', run: () => setDialog('toolbar')},
    {id: 'fullscreen', label: 'Полный экран', group: 'Окно', run: async () => {if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();}},
  ]);

  useEffect(() => {
    const controller = new AbortController();
    installCommandShortcuts(commandRegistry, () => sessionRef.current.settings.shortcuts, controller.signal);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {setDialog(null); setFindOpen(false);}
    }, {signal: controller.signal, capture: true});
    return () => controller.abort();
  }, [commandRegistry]);

  const analysis = useMemo(() => renderMarkdown(activeTab?.markdown || '', session.settings.jiraBase), [activeTab?.markdown, session.settings.jiraBase]);
  const activeVersions = activeTab ? versions.current.get(activeTab.id) || [] : [];
  const toolbarCommands = session.settings.toolbarCommands.map((id) => commandRegistry.get(id)).filter((command): command is FortisCommand => Boolean(command));
  const conflicts = shortcutConflicts(session.settings.shortcuts);
  const jiraDescription = markdownToJiraDescription(activeTab?.markdown || '');
  const diffMarkdown = diffTarget === 'saved' ? activeTab?.savedMarkdown || ''
    : diffTarget === 'disk' ? diffDisk || ''
      : session.tabs.find((tab) => tab.id === diffTarget)?.markdown || '';

  return (
    <ThemeProvider theme={theme.gravity} lang="ru" rootClassName="fortis-theme-root">
    <div className="fortis-app">
      <header className="topbar">
        <div className="brand"><strong>FORTIS</strong><span className="brand-mark" aria-hidden="true" /><span>MARKDOWN EDITOR</span></div>
        {session.settings.menuVisible ? <CommandMenu registry={commandRegistry} shortcuts={session.settings.shortcuts} /> : null}
        <div className="top-actions">
          <button type="button" title="Недавние и закладки" onClick={() => void commandRegistry.execute('recent')}>★</button>
          <button type="button" title="Настройки Jira/Bitbucket" onClick={() => void commandRegistry.execute('settings')}>⚙</button>
          <button type="button" title="Скрыть меню" onClick={() => void commandRegistry.execute('toggleMenu')}>☰</button>
        </div>
      </header>

      {session.settings.toolbarVisible ? <div className="actionbar">
        {toolbarCommands.map((command, index) => <button
          type="button"
          className={index > 0 && toolbarCommands[index - 1].group !== command.group ? 'toolbar-new-group' : undefined}
          key={command.id}
          title={`${command.label}${session.settings.shortcuts[command.id] ? ` (${session.settings.shortcuts[command.id]})` : ''}`}
          disabled={!commandRegistry.isEnabled(command.id)}
          onClick={() => void commandRegistry.execute(command.id)}
        >{TOOLBAR_ICONS[command.id] || '•'}<small>{command.label.replace(/[…\.]+$/u, '').split(' ')[0]}</small></button>)}
        <button type="button" className="toolbar-new-group" title="Настроить панель" onClick={() => void commandRegistry.execute('toolbar')}>☷<small>Настроить</small></button>
      </div> : null}

      {formulaEdit ? <FormulaPanel edit={formulaEdit} onClose={() => setFormulaEdit(null)} /> : null}

      <div className="tabs-bar">
        {session.tabs.map((tab) => <button type="button" className={`file-tab${tab.id === session.activeId ? ' active' : ''}`} key={tab.id} onClick={() => setSession((current) => ({...current, activeId: tab.id}))}>
          <span>{tab.dirty ? '● ' : ''}{tab.name}</span><i role="button" aria-label={`Закрыть ${tab.name}`} onClick={(event) => {event.stopPropagation(); closeTab(tab);}}>×</i>
        </button>)}
        {!session.tabs.length ? <button type="button" className="new-empty-tab" onClick={() => addDocument('Без имени.md', '', {dirty: true})}>＋ Новый документ</button> : null}
      </div>

      {findOpen ? <div className="findbar">
        <TextInput autoFocus size="s" placeholder="Найти" value={findQuery} onUpdate={setFindQuery} />
        <TextInput size="s" placeholder="Заменить" value={replaceQuery} onUpdate={setReplaceQuery} />
        <Button size="s" onClick={() => applyFindReplace(false)}>Заменить</Button>
        <Button size="s" onClick={() => applyFindReplace(true)}>Заменить всё</Button>
        <Button size="s" onClick={() => void searchWorkspace()}>В папке</Button>
        <button type="button" className="icon-button" onClick={() => {setFindOpen(false); setWorkspaceHits([]);}}>×</button>
      </div> : null}

      <main className="workspace">
        {session.settings.treeVisible ? <div className="left-pane" style={{width: session.settings.treeWidth}}><WorkspaceTree root={workspace} onOpen={(node) => void openWorkspaceNode(node)} />
          {workspaceHits.length ? <div className="workspace-hits"><div className="panel-title">РЕЗУЛЬТАТЫ</div>{workspaceHits.map((hit, index) => <button key={`${hit.node.key}-${hit.line}-${index}`} onClick={() => void openWorkspaceNode(hit.node, hit.line)}><strong>{hit.node.name}:{hit.line + 1}</strong><span>{hit.text}</span></button>)}</div> : null}
        </div> : null}
        <section className="editor-area">
          {session.tabs.map((tab) => <EditorPane
            key={tab.id}
            tab={tab}
            active={tab.id === session.activeId}
            viewMode={session.settings.viewMode}
            jiraBase={session.settings.jiraBase}
            theme={theme.gravity}
            toolbarVisible
            spellcheck={session.settings.spellcheck}
            syncScroll={session.settings.syncScroll}
            onChange={markUserChange}
            onReady={(id, adapter) => {if (adapter) adapters.current.set(id, adapter); else adapters.current.delete(id);}}
          />)}
          {!activeTab ? <div className="empty-editor"><span>F</span><h1>FORTIS</h1><p>Создайте документ или откройте Markdown-файл.</p></div> : null}
        </section>
        {session.settings.docPanelVisible ? <div className="right-pane" style={{width: session.settings.panelWidth}}><DocumentPanel
          tab={activeTab}
          panel={session.settings.docPanel}
          jiraBase={session.settings.jiraBase}
          versions={activeVersions}
          onPanel={(panel: PanelType) => setSession((current) => ({...current, settings: {...current.settings, docPanel: panel}}))}
          onInsert={insert}
          onReveal={(href) => activeTab && adapters.current.get(activeTab.id)?.reveal({headingId: href.replace(/^#/u, '')})}
          onOpenRelative={openRelativeFile}
          onRestore={(version) => {
            if (!activeTab) return;
            snapshot(activeTab.id, 'перед восстановлением');
            replaceTabMarkdown(activeTab.id, version.markdown);
            notify('Версия восстановлена.');
          }}
        /></div> : null}
      </main>

      <footer className="statusbar">
        <div className="mode-switch">
          {([['wysiwyg', 'Визуально'], ['markup', 'Разметка'], ['split', 'Рядом']] as const).map(([mode, label]) => <button key={mode} type="button" className={session.settings.viewMode === mode ? 'active' : ''} onClick={() => setViewMode(mode)}>{label}</button>)}
        </div>
        <span>{activeTab ? `${analysis.words} слов · ${analysis.characters} знаков` : 'Нет открытого документа'}</span>
        <span>{activeTab?.dirty ? 'Есть несохранённые изменения' : activeTab?.savedAt ? `Сохранён ${new Date(activeTab.savedAt).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}` : 'Готово'}</span>
        <button type="button" onClick={() => setSession((current) => ({...current, settings: {...current.settings, treeVisible: !current.settings.treeVisible}}))}>Дерево</button>
        <button type="button" onClick={() => setSession((current) => ({...current, settings: {...current.settings, docPanelVisible: !current.settings.docPanelVisible}}))}>Панель</button>
      </footer>

      {toast ? <div className="fortis-toast">{toast}</div> : null}

      {dialog === 'themes' ? <Modal title="Оформление" onClose={() => setDialog(null)} wide><div className="theme-grid">{THEMES.map((item) => <button type="button" key={item.id} className={item.id === theme.id ? 'selected' : ''} onClick={() => setSession((current) => ({...current, settings: {...current.settings, theme: item.id}}))}><span style={{background: item.background, borderColor: item.edge}}><i style={{background: item.accent}} /></span><strong>{item.name}</strong><small>{item.gravity === 'dark' ? 'тёмная' : 'светлая'}</small></button>)}</div></Modal> : null}

      {dialog === 'export' ? <Modal title="Экспорт документа" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Отмена</Button><Button view="action" onClick={() => void exportDocument()}>Экспортировать</Button></>}>
        <SegmentedRadioGroup value={exportFormat} onUpdate={(value) => setExportFormat(value as typeof exportFormat)}><SegmentedRadioGroup.Option value="html">HTML</SegmentedRadioGroup.Option><SegmentedRadioGroup.Option value="pdf">PDF</SegmentedRadioGroup.Option><SegmentedRadioGroup.Option value="txt">TXT</SegmentedRadioGroup.Option></SegmentedRadioGroup>
        <label className="form-row"><input type="checkbox" checked={exportSelection} onChange={(event) => setExportSelection(event.target.checked)} /> Только выделенный фрагмент</label>
        {exportFormat === 'pdf' ? <div className="form-grid"><label>Размер<select value={pageSize} onChange={(event) => setPageSize(event.target.value)}><option>A4</option><option>A3</option><option>Letter</option></select></label><label>Ориентация<select value={pageOrientation} onChange={(event) => setPageOrientation(event.target.value)}><option value="portrait">Книжная</option><option value="landscape">Альбомная</option></select></label><label>Поля, мм<input type="number" min="0" max="50" value={pageMargin} onChange={(event) => setPageMargin(Number(event.target.value))} /></label></div> : null}
        <p className="modal-note">Формулы и Mermaid встраиваются в результат. Сетевые ресурсы не используются.</p>
      </Modal> : null}

      {dialog === 'import' && importPreview ? <Modal title="Предпросмотр импорта" onClose={() => {setDialog(null); setImportPreview(null);}} wide footer={<><Button onClick={() => {setDialog(null); setImportPreview(null);}}>Отмена</Button><Button view="action" onClick={() => {addDocument(importPreview.name, importPreview.markdown, {dirty: true}); setDialog(null); setImportPreview(null);}}>Открыть как Markdown</Button></>}>
        {importPreview.losses.length ? <div className="warning-box">Не перенесено: {importPreview.losses.join(', ')}.</div> : null}
        <pre className="import-preview">{importPreview.markdown.slice(0, 20_000)}</pre>
      </Modal> : null}

      {dialog === 'settings' ? <Modal title="Интеграции и настройки" onClose={() => setDialog(null)} footer={<Button view="action" onClick={() => setDialog(null)}>Готово</Button>}>
        <label className="field-label">Адрес Jira<TextInput value={session.settings.jiraBase} onUpdate={(jiraBase) => setSession((current) => ({...current, settings: {...current.settings, jiraBase}}))} /></label>
        <label className="field-label">Адрес Bitbucket<TextInput value={session.settings.bitbucketBase} onUpdate={(bitbucketBase) => setSession((current) => ({...current, settings: {...current.settings, bitbucketBase}}))} /></label>
        <label className="form-row"><input type="checkbox" checked={session.settings.spellcheck} onChange={(event) => setSession((current) => ({...current, settings: {...current.settings, spellcheck: event.target.checked}}))} /> Проверка орфографии</label>
        <label className="form-row"><input type="checkbox" checked={session.settings.syncScroll} onChange={(event) => setSession((current) => ({...current, settings: {...current.settings, syncScroll: event.target.checked}}))} /> Синхронная прокрутка в режиме «Рядом»</label>
        <label className="form-row">Масштаб <input type="range" min="0.5" max="2" step="0.1" value={session.settings.zoom} onChange={(event) => setSession((current) => ({...current, settings: {...current.settings, zoom: Number(event.target.value)}}))} /> {Math.round(session.settings.zoom * 100)}%</label>
      </Modal> : null}

      {dialog === 'templates' ? <Modal title="Новый документ из шаблона" onClose={() => setDialog(null)}><p className="modal-note">Шаблон откроется в новой вкладке и сохранится как переносимый GFM.</p><div className="template-grid">{DOCUMENT_TEMPLATES.map((template) => <button type="button" key={template.id} onClick={() => {addDocument(`${template.name}.md`, template.markdown, {dirty: true}); setDialog(null);}}><strong>{template.name}</strong><span>{template.note}</span></button>)}</div></Modal> : null}

      {dialog === 'jiraDescription' && activeTab ? <Modal title="Описание для Jira" onClose={() => setDialog(null)} wide footer={<><Button onClick={() => setDialog(null)}>Закрыть</Button><Button view="action" onClick={async () => {try {await navigator.clipboard.writeText(jiraDescription); notify('Описание Jira скопировано.');} catch {notify('Не удалось записать в буфер — скопируйте текст вручную.');}}}>Скопировать</Button></>}><p className="modal-note">Заголовки, списки, цитаты, код и ссылки переведены в Jira wiki markup. Исходный Markdown не изменён.</p><textarea className="jira-description" readOnly value={jiraDescription} /></Modal> : null}

      {dialog === 'shortcuts' ? <Modal title="Горячие клавиши" onClose={() => setDialog(null)} wide footer={<><Button onClick={() => setSession((current) => ({...current, settings: {...current.settings, shortcuts: {...DEFAULT_SHORTCUTS}}}))}>Сбросить</Button><Button view="action" onClick={() => setDialog(null)} disabled={conflicts.size > 0}>Готово</Button></>}>
        <p className="modal-note">Выберите поле и нажмите сочетание. Backspace удаляет назначение. Конфликтующие сочетания нужно исправить.</p>
        {conflicts.size ? <div className="warning-box">Конфликты: {Array.from(conflicts).map(([combo, ids]) => `${combo} — ${ids.join(', ')}`).join('; ')}</div> : null}
        <div className="shortcut-grid">{commandRegistry.list().map((command) => <label key={command.id}><span>{command.label}<small>{command.group}</small></span><input
          readOnly
          value={session.settings.shortcuts[command.id] || ''}
          onKeyDown={(event) => {
            event.preventDefault(); event.stopPropagation();
            const combo = event.key === 'Backspace' || event.key === 'Delete' ? '' : keyboardCombo(event.nativeEvent);
            if (combo && /^(Ctrl|Alt|Shift)(\+(Ctrl|Alt|Shift))*$/u.test(combo)) return;
            setSession((current) => ({...current, settings: {...current.settings, shortcuts: {...current.settings.shortcuts, [command.id]: combo}}}));
          }}
        /></label>)}</div>
      </Modal> : null}

      {dialog === 'toolbar' ? <Modal title="Настройка панели" onClose={() => setDialog(null)} wide footer={<><Button onClick={() => setSession((current) => ({...current, settings: {...current.settings, toolbarCommands: [...DEFAULT_TOOLBAR_COMMANDS]}}))}>По умолчанию</Button><Button view="action" onClick={() => setDialog(null)}>Готово</Button></>}><p className="modal-note">Команды отображаются в порядке реестра. Состояние панели сохраняется в сессии.</p><div className="toolbar-config">{commandRegistry.list().map((command) => <label key={command.id}><input type="checkbox" checked={session.settings.toolbarCommands.includes(command.id)} onChange={() => setSession((current) => ({...current, settings: {...current.settings, toolbarCommands: current.settings.toolbarCommands.includes(command.id) ? current.settings.toolbarCommands.filter((id) => id !== command.id) : [...current.settings.toolbarCommands, command.id]}}))} /><span>{TOOLBAR_ICONS[command.id] || '•'}</span>{command.label}<small>{command.group}</small></label>)}</div></Modal> : null}

      {dialog === 'recent' ? <Modal title="Недавние и закладки" onClose={() => setDialog(null)}><h3>Закладки</h3>{session.bookmarks.map((item) => <button type="button" className="recent-row" key={item.key} onClick={() => void openRemembered(item.key, item.name)}>★ {item.name}</button>)}<h3>Недавние</h3>{session.recent.map((item) => <button type="button" className="recent-row" key={item.key} onClick={() => void openRemembered(item.key, item.name)}><span>{item.name}</span><small>{new Date(item.ts).toLocaleString('ru-RU')}</small></button>)}</Modal> : null}

      {dialog === 'diff' && activeTab ? <Modal title="Сравнение Markdown" onClose={() => setDialog(null)} wide><label className="field-label">Сравнить текущий документ с<select value={diffTarget} onChange={(event) => setDiffTarget(event.target.value)}><option value="saved">последней сохранённой версией</option>{diffDisk != null ? <option value="disk">файлом на диске</option> : null}{session.tabs.filter((tab) => tab.id !== activeTab.id).map((tab) => <option key={tab.id} value={tab.id}>вкладкой «{tab.name}»</option>)}</select></label><pre className="diff-view">{diffLines(diffMarkdown, activeTab.markdown).map((line, index) => <span className={`diff-${line.kind}`} key={index}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}{line.text}{'\n'}</span>)}</pre></Modal> : null}

      {dialog === 'table' && activeTab ? <TableLab markdown={activeTab.markdown} onClose={() => setDialog(null)} onApply={(markdown) => {replaceTabMarkdown(activeTab.id, markdown); setDialog(null);}} /> : null}

      {recovery ? <Modal title="Восстановить черновики?" onClose={() => {localStorage.removeItem(AUTOSAVE_KEY); setRecovery(null);}} footer={<><Button onClick={() => {localStorage.removeItem(AUTOSAVE_KEY); setRecovery(null);}}>Не восстанавливать</Button><Button view="action" onClick={() => {
        for (const recovered of recovery.tabs) {
          const existing = sessionRef.current.tabs.find((tab) => tab.name === recovered.name);
          if (existing) replaceTabMarkdown(existing.id, recovered.md);
          else addDocument(recovered.name, recovered.md, {dirty: true});
        }
        setRecovery(null); notify('Черновики восстановлены.');
      }}>Восстановить</Button></>}><p>После предыдущего запуска остались несохранённые документы от {new Date(recovery.ts).toLocaleString('ru-RU')}.</p><ul>{recovery.tabs.map((tab) => <li key={tab.name}>{tab.name}</li>)}</ul></Modal> : null}

      {conflict ? <Modal title="Файл изменён на диске" onClose={() => setConflict(null)} footer={<><Button onClick={() => setConflict(null)}>Отмена</Button><Button onClick={() => {setConflict(null); void saveTab(conflict.id);}}>Оставить мою версию</Button><Button view="action" onClick={() => {
        snapshot(conflict.id, 'перед версией с диска');
        const runtime = runtimeFor(runtimes.current, conflict.id);
        runtime.originalBytes = conflict.bytes;
        runtime.lastModified = conflict.lastModified;
        patchTab(conflict.id, (tab) => ({markdown: conflict.disk, savedMarkdown: conflict.disk, dirty: false, touched: false, savedAt: conflict.lastModified, revision: tab.revision + 1}));
        setConflict(null);
      }}>Взять с диска</Button></>}><p>«{conflict.name}» изменён другой программой: добавлено строк — {conflict.added}, удалено — {conflict.removed}.</p></Modal> : null}

      {closeCandidate ? <Modal title="Есть несохранённые изменения" onClose={() => setCloseCandidate(null)} footer={<><Button onClick={() => setCloseCandidate(null)}>Отмена</Button><Button onClick={() => {const tab = closeCandidate; setCloseCandidate(null); patchTab(tab.id, {dirty: false}); queueMicrotask(() => closeTab({...tab, dirty: false}));}}>Не сохранять</Button><Button view="action" onClick={async () => {if (await saveTab(closeCandidate.id)) {const tab = {...closeCandidate, dirty: false}; setCloseCandidate(null); closeTab(tab);}}}>Сохранить</Button></>}><p>Сохранить изменения в «{closeCandidate.name}» перед закрытием?</p></Modal> : null}
    </div>
    </ThemeProvider>
  );
}
