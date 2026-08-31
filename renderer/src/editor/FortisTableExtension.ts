import type {ExtensionAuto} from '@gravity-ui/markdown-editor';
import type Token from 'markdown-it/lib/token';
import {DOMSerializer, type Node as ProseMirrorNode} from 'prosemirror-model';
import {sanitizeHtml} from '../markdown/pipeline';

const TABLE = 'table';
const HEAD = 'thead';
const BODY = 'tbody';
const ROW = 'tr';
const HEADER_CELL = 'th';
const DATA_CELL = 'td';
const ALIGN = 'cell-align';

function inlineHtmlToMarkdown(element: Element): string {
  const render = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof Element)) return '';
    const content = Array.from(node.childNodes).map(render).join('');
    switch (node.tagName) {
      case 'BR': return '\n';
      case 'STRONG': case 'B': return `**${content}**`;
      case 'EM': case 'I': return `*${content}*`;
      case 'DEL': case 'S': return `~~${content}~~`;
      case 'CODE': return `\`${content.replace(/`/gu, '\\`')}\``;
      case 'A': return `[${content}](${node.getAttribute('href') || ''})`;
      case 'IMG': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
      default: return content;
    }
  };
  return Array.from(element.childNodes).map(render).join('').trim();
}

type Nesting = -1 | 0 | 1;
type MarkdownState = {Token: new(type: string, tag: string, nesting: Nesting) => Token};

function token(state: MarkdownState, type: string, tag: string, nesting: Nesting): Token {
  return new state.Token(type, tag, nesting);
}

function tableTokens(state: MarkdownState, html: string): Token[] | null {
  const clean = sanitizeHtml(html);
  const documentNode = new DOMParser().parseFromString(clean, 'text/html');
  const table = documentNode.querySelector('table');
  if (!table) return null;
  const allRows = Array.from(table.querySelectorAll('tr'));
  if (!allRows.length) return null;
  const explicitHead = Array.from(table.querySelectorAll('thead > tr'));
  const headRows = explicitHead.length ? explicitHead : [allRows[0]];
  const headSet = new Set(headRows);
  const bodyRows = allRows.filter((row) => !headSet.has(row));
  if (!bodyRows.length) {
    const empty = documentNode.createElement('tr');
    const count = Math.max(1, headRows[0].children.length);
    for (let index = 0; index < count; index += 1) empty.append(documentNode.createElement('td'));
    bodyRows.push(empty);
  }

  const result: Token[] = [];
  const tableOpen = token(state, 'table_open', 'table', 1);
  tableOpen.attrSet('data-complex', '1');
  const tableWidth = table.style.width || table.getAttribute('width');
  if (tableWidth) tableOpen.attrSet('width', tableWidth);
  result.push(tableOpen);

  const pushRows = (section: 'thead' | 'tbody', rows: HTMLTableRowElement[]) => {
    result.push(token(state, `${section}_open`, section, 1));
    for (const row of rows) {
      result.push(token(state, 'tr_open', 'tr', 1));
      for (const cell of Array.from(row.children).filter((child) => /^(TH|TD)$/u.test(child.tagName))) {
        const element = cell as HTMLTableCellElement;
        const cellType = section === 'thead' ? 'th' : element.tagName.toLowerCase();
        const open = token(state, `${cellType}_open`, cellType, 1);
        const align = element.style.textAlign || element.getAttribute('align') || 'left';
        open.attrSet('style', `text-align:${align}`);
        if (element.colSpan > 1) open.attrSet('colspan', String(element.colSpan));
        if (element.rowSpan > 1) open.attrSet('rowspan', String(element.rowSpan));
        const width = element.style.width || element.getAttribute('width');
        if (width) open.attrSet('width', width);
        result.push(open);
        const inline = token(state, 'inline', '', 0);
        inline.content = inlineHtmlToMarkdown(element);
        inline.children = [];
        result.push(inline, token(state, `${cellType}_close`, cellType, -1));
      }
      result.push(token(state, 'tr_close', 'tr', -1));
    }
    result.push(token(state, `${section}_close`, section, -1));
  };
  pushRows('thead', headRows as HTMLTableRowElement[]);
  pushRows('tbody', bodyRows as HTMLTableRowElement[]);
  result.push(token(state, 'table_close', 'table', -1));
  return result;
}

function cellAttrs(tokenValue: Token): Record<string, unknown> {
  const style = tokenValue.attrGet('style') || '';
  const align = style.match(/text-align\s*:\s*(left|center|right)/iu)?.[1]
    || tokenValue.attrGet('align')
    || 'left';
  return {
    [ALIGN]: align,
    colspan: Math.max(1, Number(tokenValue.attrGet('colspan')) || 1),
    rowspan: Math.max(1, Number(tokenValue.attrGet('rowspan')) || 1),
    width: tokenValue.attrGet('width') || style.match(/width\s*:\s*([^;]+)/iu)?.[1]?.trim() || null,
  };
}

function inlineNodeHtml(node: ProseMirrorNode): string {
  const wrapper = document.createElement('div');
  wrapper.append(DOMSerializer.fromSchema(node.type.schema).serializeFragment(node.content));
  return sanitizeHtml(wrapper.innerHTML);
}

function complexTableHtml(node: ProseMirrorNode): string {
  const renderCell = (cell: ProseMirrorNode) => {
    const tag = cell.type.name === HEADER_CELL ? 'th' : 'td';
    const attrs = [
      Number(cell.attrs.colspan) > 1 ? ` colspan="${Number(cell.attrs.colspan)}"` : '',
      Number(cell.attrs.rowspan) > 1 ? ` rowspan="${Number(cell.attrs.rowspan)}"` : '',
      cell.attrs.width ? ` width="${String(cell.attrs.width).replace(/["<>]/gu, '')}"` : '',
      cell.attrs[ALIGN] && cell.attrs[ALIGN] !== 'left' ? ` align="${cell.attrs[ALIGN]}"` : '',
    ].join('');
    return `<${tag}${attrs}>${inlineNodeHtml(cell)}</${tag}>`;
  };
  const renderRows = (section: ProseMirrorNode) => Array.from({length: section.childCount}, (_, rowIndex) => {
    const row = section.child(rowIndex);
    return `  <tr>${Array.from({length: row.childCount}, (_, cellIndex) => renderCell(row.child(cellIndex))).join('')}</tr>`;
  }).join('\n');
  const head = node.child(0);
  const body = node.child(1);
  const width = node.attrs.width ? ` width="${String(node.attrs.width).replace(/["<>]/gu, '')}"` : '';
  return sanitizeHtml(`<table${width}>\n <thead>\n${renderRows(head)}\n </thead>\n <tbody>\n${renderRows(body)}\n </tbody>\n</table>`);
}

function isComplex(node: ProseMirrorNode): boolean {
  if (node.attrs.complex || node.attrs.width) return true;
  let complex = false;
  node.descendants((child) => {
    if ((child.type.name === HEADER_CELL || child.type.name === DATA_CELL)
      && (Number(child.attrs.colspan) > 1 || Number(child.attrs.rowspan) > 1 || child.attrs.width)) complex = true;
  });
  return complex;
}

export const FortisTableExtension: ExtensionAuto = (builder) => {
  builder.configureMd((md) => {
    md.core.ruler.after('block', 'fortis_html_tables', (state) => {
      for (let index = 0; index < state.tokens.length; index += 1) {
        const current = state.tokens[index];
        if (current.type !== 'html_block' || !/^\s*<table\b[\s\S]*<\/table>\s*$/iu.test(current.content)) continue;
        const converted = tableTokens(state, current.content);
        if (converted) state.tokens.splice(index, 1, ...converted);
      }
    });
    return md;
  });

  builder
    .overrideNodeSpec(TABLE, (previous) => ({
      ...previous,
      attrs: {...previous.attrs, complex: {default: false}, width: {default: null}},
      parseDOM: [{
        tag: 'table',
        getAttrs: (dom) => ({
          complex: Boolean((dom as HTMLTableElement).querySelector('[rowspan],[colspan],[width],[style*="width"]')),
          width: (dom as HTMLTableElement).style.width || (dom as HTMLTableElement).getAttribute('width'),
        }),
      }],
      toDOM(node) {
        return ['table', {
          'data-complex': node.attrs.complex ? '1' : undefined,
          style: node.attrs.width ? `width:${node.attrs.width}` : undefined,
        }, 0];
      },
    }))
    .overrideMarkdownTokenParserSpec(TABLE, (previous) => ({
      ...previous,
      getAttrs: (value) => ({complex: value.attrGet('data-complex') === '1', width: value.attrGet('width')}),
    }));

  for (const name of [HEADER_CELL, DATA_CELL]) {
    builder
      .overrideNodeSpec(name, (previous) => ({
        ...previous,
        attrs: {
          ...previous.attrs,
          colspan: {default: 1},
          rowspan: {default: 1},
          width: {default: null},
        },
        parseDOM: [{tag: name, getAttrs: (dom) => cellAttrsFromDom(dom as HTMLTableCellElement)}],
        toDOM(node) {
          const align = node.attrs[ALIGN] || 'left';
          const width = node.attrs.width ? `;width:${node.attrs.width}` : '';
          return [name, {
            [ALIGN]: align,
            colspan: Number(node.attrs.colspan) > 1 ? Number(node.attrs.colspan) : undefined,
            rowspan: Number(node.attrs.rowspan) > 1 ? Number(node.attrs.rowspan) : undefined,
            style: `text-align:${align}${width}`,
          }, 0];
        },
      }))
      .overrideMarkdownTokenParserSpec(name, (previous) => ({...previous, getAttrs: cellAttrs}));
  }

  builder.overrideNodeSerializerSpec(TABLE, (previous) => (state, node, parent, index) => {
    if (!isComplex(node)) {
      previous(state, node, parent, index);
      return;
    }
    state.ensureNewLine();
    state.write(`${complexTableHtml(node)}\n`);
    state.closeBlock(node);
  });
};

function cellAttrsFromDom(element: HTMLTableCellElement): Record<string, unknown> {
  const align = element.style.textAlign || element.getAttribute('align') || 'left';
  return {
    [ALIGN]: align,
    colspan: Math.max(1, element.colSpan || 1),
    rowspan: Math.max(1, element.rowSpan || 1),
    width: element.style.width || element.getAttribute('width'),
  };
}
