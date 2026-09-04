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
const BACKGROUND = 'fortis-background';
const COLOR = 'fortis-color';
const SOURCE_HTML = 'fortis-source-html';
const SOURCE_MARKDOWN = 'fortis-source-markdown';
const COLUMN_WIDTHS = 'fortis-column-widths';

function inlineHtmlToMarkdown(element: Element): string {
  const render = (node: Node, listDepth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof Element)) return '';
    const content = Array.from(node.childNodes).map((child) => render(child, listDepth)).join('');
    switch (node.tagName) {
      case 'BR': return '\n';
      case 'STRONG': case 'B': return `**${content}**`;
      case 'EM': case 'I': return `*${content}*`;
      case 'DEL': case 'S': return `~~${content}~~`;
      case 'CODE': return `\`${content.replace(/`/gu, '\\`')}\``;
      case 'A': return `[${content}](${node.getAttribute('href') || ''})`;
      case 'IMG': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
      case 'UL': case 'OL': return Array.from(node.children).filter((child) => child.tagName === 'LI').map((child, index) => {
        const own = Array.from(child.childNodes).filter((part) => !(part instanceof Element && /^(UL|OL)$/u.test(part.tagName))).map((part) => render(part, listDepth + 1)).join('').trim();
        const nested = Array.from(child.children).filter((part) => /^(UL|OL)$/u.test(part.tagName)).map((part) => render(part, listDepth + 1)).join('\n');
        const marker = node.tagName === 'OL' ? `${index + 1}.` : listDepth ? '◦' : '•';
        return `${marker} ${own}${nested ? `\n${nested}` : ''}`;
      }).join('\n');
      case 'P': case 'DIV': return `${content.trim()}\n`;
      default: return content;
    }
  };
  return Array.from(element.childNodes).map((node) => render(node)).join('').replace(/\n{3,}/gu, '\n\n').trim();
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
  const firstCells = Array.from(allRows[0].children).filter((cell) => /^(TH|TD)$/u.test(cell.tagName)) as HTMLTableCellElement[];
  const implicitHeadCount = firstCells.length && firstCells.every((cell) => cell.tagName === 'TH')
    ? Math.max(1, ...firstCells.map((cell) => cell.rowSpan || 1))
    : 1;
  const headRows = explicitHead.length ? explicitHead : allRows.slice(0, Math.min(allRows.length, implicitHeadCount));
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
  const colgroup = Array.from(table.children).find((element) => element.tagName === 'COLGROUP');
  const columnWidths = colgroup ? Array.from(colgroup.children).filter((element) => element.tagName === 'COL').map((element) => (element as HTMLElement).style.width || element.getAttribute('width') || '') : [];
  if (columnWidths.some(Boolean)) tableOpen.attrSet('data-column-widths', JSON.stringify(columnWidths));
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
        if (element.style.backgroundColor) open.attrSet('data-background', element.style.backgroundColor);
        if (element.style.color) open.attrSet('data-color', element.style.color);
        const sourceHtml = sanitizeHtml(element.innerHTML);
        const sourceMarkdown = inlineHtmlToMarkdown(element);
        if (sourceHtml && /<(?:p|div|ul|ol|li)\b/iu.test(sourceHtml)) {
          open.attrSet('data-source-html', sourceHtml);
          open.attrSet('data-source-markdown', sourceMarkdown);
        }
        result.push(open);
        const inline = token(state, 'inline', '', 0);
        inline.content = sourceMarkdown;
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
    [BACKGROUND]: tokenValue.attrGet('data-background') || null,
    [COLOR]: tokenValue.attrGet('data-color') || null,
    [SOURCE_HTML]: tokenValue.attrGet('data-source-html') || null,
    [SOURCE_MARKDOWN]: tokenValue.attrGet('data-source-markdown') || null,
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
    const styles = [
      cell.attrs.width ? `width:${String(cell.attrs.width).replace(/["<>]/gu, '')}` : '',
      cell.attrs[BACKGROUND] ? `background-color:${String(cell.attrs[BACKGROUND]).replace(/["<>]/gu, '')}` : '',
      cell.attrs[COLOR] ? `color:${String(cell.attrs[COLOR]).replace(/["<>]/gu, '')}` : '',
      cell.attrs[ALIGN] && cell.attrs[ALIGN] !== 'left' ? `text-align:${cell.attrs[ALIGN]}` : '',
    ].filter(Boolean).join(';');
    const attrs = [
      Number(cell.attrs.colspan) > 1 ? ` colspan="${Number(cell.attrs.colspan)}"` : '',
      Number(cell.attrs.rowspan) > 1 ? ` rowspan="${Number(cell.attrs.rowspan)}"` : '',
      styles ? ` style="${styles}"` : '',
    ].join('');
    const currentHtml = inlineNodeHtml(cell);
    const currentDoc = new DOMParser().parseFromString(`<div>${currentHtml}</div>`, 'text/html');
    const currentMarkdown = inlineHtmlToMarkdown(currentDoc.body.firstElementChild!);
    const content = cell.attrs[SOURCE_HTML] && currentMarkdown === cell.attrs[SOURCE_MARKDOWN]
      ? String(cell.attrs[SOURCE_HTML])
      : currentHtml;
    return `<${tag}${attrs}>${content}</${tag}>`;
  };
  const renderRows = (section: ProseMirrorNode) => Array.from({length: section.childCount}, (_, rowIndex) => {
    const row = section.child(rowIndex);
    return `  <tr>${Array.from({length: row.childCount}, (_, cellIndex) => renderCell(row.child(cellIndex))).join('')}</tr>`;
  }).join('\n');
  const head = node.child(0);
  const body = node.child(1);
  const width = node.attrs.width ? ` style="width:${String(node.attrs.width).replace(/["<>]/gu, '')}"` : '';
  const columnWidths = Array.isArray(node.attrs[COLUMN_WIDTHS]) ? node.attrs[COLUMN_WIDTHS] as string[] : [];
  const colgroup = columnWidths.some(Boolean) ? `\n <colgroup>${columnWidths.map((value) => `<col${value ? ` style="width:${String(value).replace(/["<>]/gu, '')}"` : ''}>`).join('')}</colgroup>` : '';
  return sanitizeHtml(`<table${width}>${colgroup}\n <thead>\n${renderRows(head)}\n </thead>\n <tbody>\n${renderRows(body)}\n </tbody>\n</table>`);
}

function isComplex(node: ProseMirrorNode): boolean {
  if (node.attrs.complex || node.attrs.width || (Array.isArray(node.attrs[COLUMN_WIDTHS]) && node.attrs[COLUMN_WIDTHS].some(Boolean))) return true;
  let complex = false;
  node.descendants((child) => {
    if ((child.type.name === HEADER_CELL || child.type.name === DATA_CELL)
      && (Number(child.attrs.colspan) > 1 || Number(child.attrs.rowspan) > 1 || child.attrs.width || child.attrs[BACKGROUND] || child.attrs[COLOR] || child.attrs[SOURCE_HTML])) complex = true;
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
      attrs: {...previous.attrs, complex: {default: false}, width: {default: null}, [COLUMN_WIDTHS]: {default: []}},
      parseDOM: [{
        tag: 'table',
        getAttrs: (dom) => ({
          complex: Boolean((dom as HTMLTableElement).querySelector('[rowspan],[colspan],[width],[style*="width"]')),
          width: (dom as HTMLTableElement).style.width || (dom as HTMLTableElement).getAttribute('width'),
          [COLUMN_WIDTHS]: tableColumnWidths(dom as HTMLTableElement),
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
      getAttrs: (value) => ({complex: value.attrGet('data-complex') === '1', width: value.attrGet('width'), [COLUMN_WIDTHS]: parseColumnWidths(value.attrGet('data-column-widths'))}),
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
          [BACKGROUND]: {default: null},
          [COLOR]: {default: null},
          [SOURCE_HTML]: {default: null},
          [SOURCE_MARKDOWN]: {default: null},
        },
        parseDOM: [{tag: name, getAttrs: (dom) => cellAttrsFromDom(dom as HTMLTableCellElement)}],
        toDOM(node) {
          const align = node.attrs[ALIGN] || 'left';
          const styles = [
            `text-align:${align}`,
            node.attrs.width ? `width:${node.attrs.width}` : '',
            node.attrs[BACKGROUND] ? `background-color:${node.attrs[BACKGROUND]}` : '',
            node.attrs[COLOR] ? `color:${node.attrs[COLOR]}` : '',
          ].filter(Boolean).join(';');
          return [name, {
            [ALIGN]: align,
            colspan: Number(node.attrs.colspan) > 1 ? Number(node.attrs.colspan) : undefined,
            rowspan: Number(node.attrs.rowspan) > 1 ? Number(node.attrs.rowspan) : undefined,
            style: styles,
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
    [BACKGROUND]: element.style.backgroundColor || null,
    [COLOR]: element.style.color || null,
    [SOURCE_HTML]: null,
    [SOURCE_MARKDOWN]: null,
  };
}

function tableColumnWidths(table: HTMLTableElement): string[] {
  const colgroup = Array.from(table.children).find((element) => element.tagName === 'COLGROUP');
  return colgroup ? Array.from(colgroup.children).filter((element) => element.tagName === 'COL').map((element) => (element as HTMLElement).style.width || element.getAttribute('width') || '') : [];
}

function parseColumnWidths(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
