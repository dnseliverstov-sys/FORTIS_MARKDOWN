import {redo as codeMirrorRedo, undo as codeMirrorUndo} from '@codemirror/commands';
import type {EditorView as CodeMirrorView} from '@codemirror/view';
import {EditorView as CMView} from '@codemirror/view';
import {openSearchPanel, closeSearchPanel} from '@codemirror/search';
import {openSearch, closeSearch} from '@gravity-ui/markdown-editor/_/extensions/behavior/Search/commands.js';
import {TextSelection} from 'prosemirror-state';
import type {MarkdownEditorInstance, MarkupString} from '@gravity-ui/markdown-editor';
import type {Fragment, Node as ProseMirrorNode} from 'prosemirror-model';
import type {EditorView as ProseMirrorView} from 'prosemirror-view';
import type {RevealTarget, ViewMode} from '../types';

interface GravityAction {
  run(attrs?: Record<string, unknown>): void;
  isEnable?(): boolean;
}

interface GravityInternalEditor extends MarkdownEditorInstance {
  cm: CodeMirrorView;
  wysiwygEditor: {
    view: ProseMirrorView;
    serializer: {serialize(content: ProseMirrorNode | Fragment): string};
    actions: Record<string, GravityAction>;
  };
  changeSplitModeEnabled?(options: {splitModeEnabled: boolean}): void;
  changeToolbarVisibility?(options: {visible: boolean}): void;
  emit(event: 'rerender', value: null): void;
}

function internal(editor: MarkdownEditorInstance): GravityInternalEditor {
  // Gravity keeps the bundle surface smaller than the underlying editors.
  // The dependency is pinned, so the compatibility cast stays isolated here.
  return editor as GravityInternalEditor;
}

export function setGravityViewMode(editor: MarkdownEditorInstance, mode: ViewMode): void {
  const source = internal(editor);
  editor.changePreviewVisible(false);
  const target = mode === 'wysiwyg' ? 'wysiwyg' : 'markup';
  if (editor.currentMode !== target) editor.setEditorMode(target, {emit: false});
  source.changeSplitModeEnabled?.({splitModeEnabled: mode === 'split'});
}

export function setGravityToolbarVisible(editor: MarkdownEditorInstance, visible: boolean): void {
  internal(editor).changeToolbarVisibility?.({visible});
}

export function getGravitySelectionMarkdown(editor: MarkdownEditorInstance): string {
  const source = internal(editor);
  if (editor.currentMode === 'markup') {
    return source.cm.state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => source.cm.state.sliceDoc(range.from, range.to))
      .join('\n');
  }

  const selection = source.wysiwygEditor.view.state.selection;
  if (selection.empty) return '';
  const fragment = selection.content().content;
  return source.wysiwygEditor.serializer.serialize(fragment).replace(/\n+$/u, '');
}

export function runGravityAction(
  editor: MarkdownEditorInstance,
  actionId: string,
  attrs?: Record<string, unknown>,
): boolean {
  const source = internal(editor);
  if (editor.currentMode === 'markup') {
    if (actionId === 'undo') return codeMirrorUndo(source.cm);
    if (actionId === 'redo') return codeMirrorRedo(source.cm);
    return false;
  }

  const action = source.wysiwygEditor.actions[actionId];
  if (!action || action.isEnable?.() === false) return false;
  action.run(attrs);
  return true;
}

export function replaceGravityMarkdown(editor: MarkdownEditorInstance, markdown: string): void {
  editor.replace(markdown as MarkupString);
  // Gravity's preview-only branch does not subscribe to content changes.
  // A rerender keeps programmatic disk/recovery replacements visible there.
  internal(editor).emit('rerender', null);
}

export function refreshGravityView(editor: MarkdownEditorInstance): void {
  internal(editor).emit('rerender', null);
}

export function insertGravityMarkdown(editor: MarkdownEditorInstance, markdown: string): void {
  editor.insert(markdown as MarkupString);
}

export type MarkdownInsertion = (markdown: string) => boolean;

export function captureGravityInsertion(editor: MarkdownEditorInstance): MarkdownInsertion {
  const source = internal(editor);
  if (editor.currentMode === 'markup') {
    const selection = source.cm.state.selection;
    const documentLength = source.cm.state.doc.length;
    return (markdown) => {
      if (editor.currentMode !== 'markup' || source.cm.state.doc.length !== documentLength) return false;
      source.cm.dispatch({selection});
      editor.insert(markdown as MarkupString);
      return true;
    };
  }
  const view = source.wysiwygEditor.view;
  const selection = view.state.selection;
  const documentNode = view.state.doc;
  return (markdown) => {
    if (editor.currentMode !== 'wysiwyg' || view.state.doc !== documentNode) return false;
    view.dispatch(view.state.tr.setSelection(selection));
    editor.insert(markdown as MarkupString);
    return true;
  };
}

export function insertGravityFormula(editor: MarkdownEditorInstance, tex: string, block: boolean): boolean {
  if (editor.currentMode === 'markup') {
    editor.insert((block ? `\n$$\n${tex}\n$$\n` : `$${tex}$`) as MarkupString);
    return true;
  }
  const view = internal(editor).wysiwygEditor.view;
  const type = view.state.schema.nodes[block ? 'math_display' : 'math_inline'];
  if (!type) return false;
  const node = type.create(null, tex ? view.state.schema.text(tex) : undefined);
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
  view.focus();
  return true;
}

export function getGravityProseMirrorView(editor: MarkdownEditorInstance): ProseMirrorView {
  return internal(editor).wysiwygEditor.view;
}

export function openGravitySearch(editor: MarkdownEditorInstance): void {
  const source = internal(editor);
  editor.focus();
  if (editor.currentMode === 'markup') openSearchPanel(source.cm);
  else {
    const view = source.wysiwygEditor.view;
    openSearch(view.state, view.dispatch);
  }
}

export function closeGravitySearch(editor: MarkdownEditorInstance): void {
  const source = internal(editor);
  if (editor.currentMode === 'markup') closeSearchPanel(source.cm);
  else {
    const view = source.wysiwygEditor.view;
    closeSearch(view.state, view.dispatch);
  }
}

export function revealGravityTarget(editor: MarkdownEditorInstance, target: RevealTarget): void {
  const source = internal(editor);
  if (editor.currentMode === 'markup') {
    if (target.line === undefined) return;
    const cm = source.cm;
    const line = cm.state.doc.line(Math.max(1, Math.min(cm.state.doc.lines, target.line + 1)));
    cm.dispatch({selection: {anchor: line.from}, effects: CMView.scrollIntoView(line.from, {y: 'center'})});
    cm.focus();
    return;
  }
  const view = source.wysiwygEditor.view;
  let index = 0;
  let position: number | undefined;
  let nearestLine = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      if (target.headingIndex === index) position = pos;
      index++;
    }
    if (target.headingIndex === undefined && target.line !== undefined) {
      const line = node.attrs['data-line'];
      if (line != null && Number(line) <= target.line && Number(line) > nearestLine) {
        nearestLine = Number(line);
        position = pos;
      }
    }
  });
  if (position === undefined) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position))).scrollIntoView());
  const dom = view.nodeDOM(position);
  if (dom instanceof HTMLElement) dom.scrollIntoView({block: 'center', inline: 'nearest'});
  view.focus();
}

export interface GravityFormulaTarget {
  tex: string;
  block: boolean;
  apply(tex: string, block: boolean): boolean;
  remove(): boolean;
}

export function getGravityFormulaTarget(editor: MarkdownEditorInstance, target: EventTarget | null): GravityFormulaTarget | null {
  if (!(target instanceof Element) || editor.currentMode !== 'wysiwyg') return null;
  const container = target.closest('.math-container') || target.closest('.math-inline,.math-block');
  if (!container) return null;
  const view = internal(editor).wysiwygEditor.view;
  const domPosition = view.posAtDOM(container, 0);
  const position = [domPosition, domPosition - 1, domPosition + 1].find((candidate) => {
    const node = candidate >= 0 ? view.state.doc.nodeAt(candidate) : null;
    return Boolean(node && ['math_inline', 'math_display'].includes(node.type.name));
  });
  if (position === undefined) return null;
  const initialNode = view.state.doc.nodeAt(position);
  if (!initialNode || !['math_inline', 'math_display'].includes(initialNode.type.name)) return null;

  const current = () => view.state.doc.nodeAt(position);
  return {
    tex: initialNode.textContent,
    block: initialNode.type.name === 'math_display',
    apply(tex, block) {
      const node = current();
      if (!node || !['math_inline', 'math_display'].includes(node.type.name)) return false;
      const type = view.state.schema.nodes[block ? 'math_display' : 'math_inline'];
      if (!type) return false;
      const content = tex ? view.state.schema.text(tex) : undefined;
      const replacement = type.create(null, content);
      view.dispatch(view.state.tr.replaceRangeWith(position, position + node.nodeSize, replacement));
      return true;
    },
    remove() {
      const node = current();
      if (!node || !['math_inline', 'math_display'].includes(node.type.name)) return false;
      view.dispatch(view.state.tr.delete(position, position + node.nodeSize));
      return true;
    },
  };
}
