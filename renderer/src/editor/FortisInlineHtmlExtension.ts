import type {ExtensionAuto} from '@gravity-ui/markdown-editor';

const INLINE_HTML = 'html_inline';
const HTML_CONTENT = 'html-content';
const INLINE_BREAK = /^<br\s*\/?\s*>$/iu;

export function renderInlineBreakHtml(html: string): HTMLElement | null {
  if (!INLINE_BREAK.test(html.trim())) return null;
  const element = document.createElement('span');
  element.setAttribute('data-html', '');
  element.setAttribute('data-fortis-inline-break', html);
  element.contentEditable = 'false';
  element.append(document.createElement('br'));
  return element;
}

export const FortisInlineHtmlExtension: ExtensionAuto = (builder) => {
  builder.overrideNodeSpec(INLINE_HTML, (previous) => {
    const previousToDom = previous.toDOM;
    return {
      ...previous,
      parseDOM: [{
        tag: 'span[data-fortis-inline-break]',
        getAttrs: (dom) => ({
          [HTML_CONTENT]: (dom as HTMLElement).getAttribute('data-fortis-inline-break') || '<br>',
        }),
      }, ...(previous.parseDOM || [])],
      toDOM(node) {
        const html = String(node.attrs[HTML_CONTENT] || '');
        return renderInlineBreakHtml(html)
          || previousToDom?.(node)
          || ['span', {'data-html': ''}, html];
      },
    };
  });
};
