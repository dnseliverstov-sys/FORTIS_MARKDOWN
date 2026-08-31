import {redo as codeMirrorRedo, undo as codeMirrorUndo} from '@codemirror/commands';
import type {EditorView as CodeMirrorView} from '@codemirror/view';
import type {MarkdownEditorInstance, MarkupString} from '@gravity-ui/markdown-editor';
import type {Fragment, Node as ProseMirrorNode} from 'prosemirror-model';
import type {EditorView as ProseMirrorView} from 'prosemirror-view';
import type {ViewMode} from '../types';

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

export function insertGravityMarkdown(editor: MarkdownEditorInstance, markdown: string): void {
  editor.insert(markdown as MarkupString);
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
