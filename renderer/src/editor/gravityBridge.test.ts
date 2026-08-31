import {describe, expect, it, vi} from 'vitest';
import type {MarkdownEditorInstance} from '@gravity-ui/markdown-editor';
import {getGravitySelectionMarkdown, setGravityViewMode} from './gravityBridge';

describe('Gravity editor bridge', () => {
  it('returns the exact CodeMirror selection', () => {
    const editor = {
      currentMode: 'markup',
      cm: {
        state: {
          selection: {ranges: [{from: 2, to: 9, empty: false}]},
          sliceDoc: (from: number, to: number) => '# A\r\nтекст'.slice(from, to),
        },
      },
    } as unknown as MarkdownEditorInstance;
    expect(getGravitySelectionMarkdown(editor)).toBe('A\r\nтекс');
  });

  it('serializes a ProseMirror fragment instead of reading visible text', () => {
    const serialize = vi.fn(() => '**жирный**\n');
    const fragment = {forEach: vi.fn()};
    const editor = {
      currentMode: 'wysiwyg',
      wysiwygEditor: {
        view: {state: {selection: {empty: false, content: () => ({content: fragment})}}},
        serializer: {serialize},
      },
    } as unknown as MarkdownEditorInstance;
    expect(getGravitySelectionMarkdown(editor)).toBe('**жирный**');
    expect(serialize).toHaveBeenCalledWith(fragment);
  });

  it('switches split mode without emitting an editor-mode event', () => {
    const setEditorMode = vi.fn();
    const changeSplitModeEnabled = vi.fn();
    const changePreviewVisible = vi.fn();
    const editor = {
      currentMode: 'wysiwyg',
      setEditorMode,
      changeSplitModeEnabled,
      changePreviewVisible,
    } as unknown as MarkdownEditorInstance;
    setGravityViewMode(editor, 'split');
    expect(setEditorMode).toHaveBeenCalledWith('markup', {emit: false});
    expect(changeSplitModeEnabled).toHaveBeenCalledWith({splitModeEnabled: true});
    expect(changePreviewVisible).toHaveBeenCalledWith(false);
  });
});
