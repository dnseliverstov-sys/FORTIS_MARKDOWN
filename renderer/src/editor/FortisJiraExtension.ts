import type {ExtensionWithOptions} from '@gravity-ui/markdown-editor';
import {Plugin} from 'prosemirror-state';
import {Decoration, DecorationSet} from 'prosemirror-view';

export interface FortisJiraOptions {
  getBaseUrl(): string;
}

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/gu;

export const FortisJiraExtension: ExtensionWithOptions<FortisJiraOptions> = (builder, options) => {
  builder.addPlugin(() => new Plugin({
    props: {
      decorations(state) {
        const configuredBase = options.getBaseUrl();
        if (!configuredBase) return DecorationSet.empty;
        const base = configuredBase.replace(/\/+$/u, '');
        const decorations: Decoration[] = [];
        state.doc.descendants((node, position, parent) => {
          if (!node.isText || !node.text || parent?.type.name === 'code_block') return;
          if (node.marks.some((mark) => mark.type.name === 'link' || mark.type.name === 'code')) return;
          for (const match of node.text.matchAll(JIRA_KEY)) {
            const key = match[0];
            const start = position + (match.index || 0);
            decorations.push(Decoration.inline(start, start + key.length, {
              nodeName: 'a',
              class: 'fortis-jira',
              href: `${base}/browse/${key}`,
              target: '_blank',
              rel: 'noreferrer',
              'data-jira': '1',
            }));
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  }));
};
