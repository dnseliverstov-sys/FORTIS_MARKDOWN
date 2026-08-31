import {useEffect, useRef} from 'react';
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
import {
  getGravitySelectionMarkdown,
  getGravityProseMirrorView,
  getGravityFormulaTarget,
  insertGravityFormula,
  insertGravityMarkdown,
  replaceGravityMarkdown,
  runGravityAction,
  setGravityToolbarVisible,
  setGravityViewMode,
} from '../editor/gravityBridge';
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
}

export function EditorPane({tab, viewMode, jiraBase, theme, active, toolbarVisible, spellcheck, syncScroll, onChange, onReady}: Props) {
  const suppress = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const jiraBaseRef = useRef(jiraBase);
  jiraBaseRef.current = jiraBase;
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
      renderPreview: ({getValue}) => <MarkdownPreview markdown={getValue()} jiraBase={jiraBase} theme={theme} />,
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
      },
    },
  }, [tab.id]);

  useEffect(() => {
    const changed = () => {
      if (!suppress.current) onChange(tab.id, editor.getValue());
    };
    editor.on('change', changed);
    return () => editor.off('change', changed);
  }, [editor, onChange, tab.id]);

  useEffect(() => {
    suppress.current = true;
    setGravityViewMode(editor, viewMode);
    queueMicrotask(() => { suppress.current = false; });
  }, [editor, viewMode]);

  useEffect(() => {
    setGravityToolbarVisible(editor, toolbarVisible);
  }, [editor, toolbarVisible]);

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
      if (locked) return;
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
    const current = editor.getValue();
    if (current === tab.markdown) return;
    suppress.current = true;
    replaceGravityMarkdown(editor, tab.markdown);
    queueMicrotask(() => { suppress.current = false; });
  }, [editor, tab.markdown, tab.revision]);

  useEffect(() => {
    const adapter: EditorAdapter = {
      getMarkdown: () => editor.getValue(),
      replaceMarkdown(markdown) {
        suppress.current = true;
        replaceGravityMarkdown(editor, markdown);
        queueMicrotask(() => { suppress.current = false; });
      },
      setViewMode: (mode) => setGravityViewMode(editor, mode),
      focus: () => editor.focus(),
      insertMarkdown: (markup) => insertGravityMarkdown(editor, markup),
      getSelectionMarkdown: () => getGravitySelectionMarkdown(editor),
      reveal(target) {
        if (typeof target.line === 'number') editor.moveCursor({line: target.line});
        else if (target.headingId) rootRef.current?.querySelector(`#${CSS.escape(target.headingId)}`)?.scrollIntoView({block: 'center'});
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

  return (
    <div ref={rootRef} className="editor-pane" hidden={!active} aria-hidden={!active}>
      <MarkdownEditorView
        editor={editor}
        autofocus={active}
        stickyToolbar
        settingsVisible={false}
        className="fortis-gravity-editor"
      />
    </div>
  );
}
