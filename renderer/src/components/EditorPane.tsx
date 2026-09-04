import {useCallback, useEffect, useRef, type ClipboardEvent as ReactClipboardEvent} from 'react';
import {
  MarkdownEditorView,
  useMarkdownEditor,
  type MarkupString,
} from '@gravity-ui/markdown-editor';
import {Mermaid} from '@gravity-ui/markdown-editor/_/extensions/additional/Mermaid/index.js';
import {LatexExtension} from '@gravity-ui/markdown-editor-latex-extension';
import type {DocumentTab, EditorAdapter, ViewMode} from '../types';
import {FortisTableExtension} from '../editor/FortisTableExtension';
import {FortisAlertExtension} from '../editor/FortisAlertExtension';
import {FortisJiraExtension} from '../editor/FortisJiraExtension';
import {FortisInlineHtmlExtension} from '../editor/FortisInlineHtmlExtension';
import {
  getGravitySelectionMarkdown,
  getGravityProseMirrorView,
  getGravityFormulaTarget,
  captureGravityInsertion,
  insertGravityFormula,
  insertGravityMarkdown,
  replaceGravityMarkdown,
  runGravityAction,
  setGravityToolbarVisible,
  setGravityViewMode,
  openGravitySearch,
  closeGravitySearch,
  revealGravityTarget,
  refreshGravityView,
} from '../editor/gravityBridge';
import {DocumentSync} from '../editor/documentSync';
import {renderMarkdown} from '../markdown/pipeline';
import {resolveNavigation} from '../markdown/navigation';
import type {MarkdownInsertion} from '../editor/gravityBridge';
import {MarkdownPreview} from './MarkdownPreview';
import {PORTABLE_MARKDOWN_POLICY} from '../markdown/policy';

interface Props {
  tab: DocumentTab;
  viewMode: ViewMode;
  jiraBase: string;
  theme: 'light' | 'dark';
  active: boolean;
  toolbarVisible: boolean;
  spellcheck: boolean;
  syncScroll: boolean;
  onChange(tabId: string, markdown: string): void;
  onReady(tabId: string, adapter: EditorAdapter | null): void;
  onHtmlTablePaste(tabId: string, html: string, insert: MarkdownInsertion): boolean;
}

export function EditorPane({tab, viewMode, jiraBase, theme, active, toolbarVisible, spellcheck, syncScroll, onChange, onReady, onHtmlTablePaste}: Props) {
  const suppress = useRef(false);
  const sync = useRef(new DocumentSync(tab.markdown));
  const appliedRevision = useRef(tab.revision);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollLock = useRef(false);
  const pendingPreview = useRef<string | null>(null);
  const revealPreview = useCallback(() => {
    const id = pendingPreview.current;
    if (!id) return;
    const node = rootRef.current?.querySelector(`.fortis-preview #${CSS.escape(id)}`);
    if (!node) { scrollLock.current = false; return; }
    pendingPreview.current = null;
    node.scrollIntoView({block: 'center', inline: 'nearest'});
    requestAnimationFrame(() => requestAnimationFrame(() => {scrollLock.current = false;}));
  }, []);
  const jiraBaseRef = useRef(jiraBase);
  jiraBaseRef.current = jiraBase;
  const previewProps = useRef({jiraBase, theme});
  previewProps.current = {jiraBase, theme};
  const editor = useMarkdownEditor({
    preset: 'default',
    md: {
      html: PORTABLE_MARKDOWN_POLICY.allowHtml,
      linkify: PORTABLE_MARKDOWN_POLICY.linkify,
      breaks: PORTABLE_MARKDOWN_POLICY.breaks,
    },
    initial: {
      markup: tab.markdown as MarkupString,
      mode: viewMode === 'wysiwyg' ? 'wysiwyg' : 'markup',
      splitModeEnabled: viewMode === 'split',
      toolbarVisible,
    },
    experimental: {
      directiveSyntax: PORTABLE_MARKDOWN_POLICY.directiveSyntax,
      preserveMarkupFormatting: PORTABLE_MARKDOWN_POLICY.preserveMarkupFormatting,
      preserveEmptyRows: PORTABLE_MARKDOWN_POLICY.preserveEmptyRows,
    },
    markupConfig: {
      splitMode: 'horizontal',
      parseHtmlOnPaste: true,
      renderPreview: ({getValue}) => <MarkdownPreview markdown={getValue()} {...previewProps.current} onRendered={revealPreview} />,
    },
    wysiwygConfig: {
      disableMarkdownAttrs: true,
      extensions: (builder) => {
        builder.use(LatexExtension, {
          loadRuntimeScript: () => {
            void import('@diplodoc/latex-extension/runtime');
            void import('@diplodoc/latex-extension/runtime/styles');
          },
        });
        builder.use(Mermaid, {
          loadRuntimeScript: () => { void import('@diplodoc/mermaid-extension/runtime'); },
          theme: {dark: 'dark', light: 'default'},
          autoSave: {enabled: true, delay: 500},
        });
        builder.use(FortisAlertExtension);
        builder.use(FortisJiraExtension, {getBaseUrl: () => jiraBaseRef.current});
        builder.use(FortisTableExtension);
        builder.use(FortisInlineHtmlExtension);
      },
    },
  }, [tab.id]);

  useEffect(() => {
    sync.current.reset(sync.current.source, editor.getValue(), editor.currentMode);
    const changed = () => {
      if (suppress.current) return;
      const markdown = sync.current.change(editor.getValue(), editor.currentMode);
      if (markdown !== null) onChange(tab.id, markdown);
    };
    editor.on('change', changed);
    return () => editor.off('change', changed);
  }, [editor, onChange, tab.id]);

  useEffect(() => {
    suppress.current = true;
    pendingPreview.current = null;
    scrollLock.current = false;
    closeGravitySearch(editor);
    setGravityViewMode(editor, viewMode);
    // CodeMirror must show the exact source, including CRLF and table spacing.
    if (viewMode !== 'wysiwyg' && editor.getValue() !== sync.current.source) replaceGravityMarkdown(editor, sync.current.source);
    sync.current.reset(sync.current.source, editor.getValue(), editor.currentMode);
    suppress.current = false;
  }, [editor, viewMode]);

  useEffect(() => {
    if (!active) closeGravitySearch(editor);
  }, [active, editor]);

  useEffect(() => {
    setGravityToolbarVisible(editor, toolbarVisible);
  }, [editor, toolbarVisible]);

  useEffect(() => {
    refreshGravityView(editor);
  }, [editor, theme, jiraBase]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.ProseMirror,.cm-content').forEach((element) => {
      element.spellcheck = spellcheck;
      element.setAttribute('spellcheck', String(spellcheck));
    });
  }, [editor, spellcheck, viewMode]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !syncScroll || viewMode !== 'split') return;
    const source = root.querySelector<HTMLElement>('.cm-scroller');
    const preview = root.querySelector<HTMLElement>('.fortis-preview');
    if (!source || !preview) return;
    let locked = false;
    const mirror = (from: HTMLElement, to: HTMLElement) => {
      if (locked || scrollLock.current) return;
      locked = true;
      const fromRange = Math.max(1, from.scrollHeight - from.clientHeight);
      const toRange = Math.max(0, to.scrollHeight - to.clientHeight);
      to.scrollTop = (from.scrollTop / fromRange) * toRange;
      requestAnimationFrame(() => {locked = false;});
    };
    const sourceScroll = () => mirror(source, preview);
    const previewScroll = () => mirror(preview, source);
    source.addEventListener('scroll', sourceScroll, {passive: true});
    preview.addEventListener('scroll', previewScroll, {passive: true});
    return () => {
      source.removeEventListener('scroll', sourceScroll);
      preview.removeEventListener('scroll', previewScroll);
    };
  }, [editor, syncScroll, viewMode]);

  useEffect(() => {
    const view = getGravityProseMirrorView(editor);
    view.dispatch(view.state.tr.setMeta('fortis-jira-refresh', true));
  }, [editor, jiraBase]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const openFormula = (event: MouseEvent) => {
      const target = getGravityFormulaTarget(editor, event.target);
      if (target) window.dispatchEvent(new CustomEvent('fortis:edit-formula', {detail: target}));
    };
    root.addEventListener('dblclick', openFormula);
    return () => root.removeEventListener('dblclick', openFormula);
  }, [editor]);

  useEffect(() => {
    if (sync.current.source === tab.markdown && appliedRevision.current === tab.revision) return;
    suppress.current = true;
    replaceGravityMarkdown(editor, tab.markdown);
    sync.current.reset(tab.markdown, editor.getValue(), editor.currentMode);
    appliedRevision.current = tab.revision;
    suppress.current = false;
  }, [editor, tab.markdown, tab.revision]);

  useEffect(() => {
    const adapter: EditorAdapter = {
      getMarkdown: () => sync.current.source,
      replaceMarkdown(markdown) {
        suppress.current = true;
        replaceGravityMarkdown(editor, markdown);
        sync.current.reset(markdown, editor.getValue(), editor.currentMode);
        suppress.current = false;
      },
      setViewMode: (mode) => setGravityViewMode(editor, mode),
      focus: () => editor.focus(),
      insertMarkdown: (markup) => insertGravityMarkdown(editor, markup),
      getSelectionMarkdown: () => getGravitySelectionMarkdown(editor),
      openSearch: () => openGravitySearch(editor),
      closeSearch: () => closeGravitySearch(editor),
      reveal(target) {
        const markdown = sync.current.source;
        const resolved = resolveNavigation(markdown, renderMarkdown(markdown).headings, target);
        scrollLock.current = true;
        revealGravityTarget(editor, resolved);
        if (resolved.headingId && editor.currentMode === 'markup' && rootRef.current?.querySelector('.fortis-preview')) {
          pendingPreview.current = resolved.headingId;
          requestAnimationFrame(() => requestAnimationFrame(revealPreview));
        } else requestAnimationFrame(() => requestAnimationFrame(() => {scrollLock.current = false;}));
      },
      execute(actionId, attrs) {
        if (actionId === 'insertFormula') return insertGravityFormula(editor, String(attrs?.tex || ''), Boolean(attrs?.block));
        const snippets: Record<string, string> = {
          alert: '> [!NOTE]\n> Текст заметки\n',
          mermaid: '```mermaid\nflowchart LR\n  A --> B\n```\n',
          math: '$E = mc^2$',
          table: '| Столбец 1 | Столбец 2 |\n| --- | --- |\n| Значение | Значение |\n',
        };
        if (snippets[actionId]) {
          insertGravityMarkdown(editor, snippets[actionId]);
          return true;
        }
        return runGravityAction(editor, actionId, attrs);
      },
    };
    onReady(tab.id, adapter);
    return () => onReady(tab.id, null);
  }, [editor, onReady, tab.id]);

  const interceptTablePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const html = event.clipboardData.getData('text/html');
    if (!/<table\b/iu.test(html)) return;
    if (!onHtmlTablePaste(tab.id, html, captureGravityInsertion(editor))) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div ref={rootRef} className="editor-pane" hidden={!active} aria-hidden={!active} onPasteCapture={interceptTablePaste}>
      <MarkdownEditorView
        editor={editor}
        autofocus={active}
        stickyToolbar
        settingsVisible={[] /* Retain native search anchors without adding Gravity's mode menu. */}
        className="fortis-gravity-editor"
      />
    </div>
  );
}
