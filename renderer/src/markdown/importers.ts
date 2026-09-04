import JSZip from 'jszip';
import TurndownService from 'turndown';
import {gfm} from 'turndown-plugin-gfm';
import {sanitizeHtml} from './pipeline';
import {PORTABLE_MARKDOWN_POLICY} from './policy';

export interface ImportResult {
  markdown: string;
  losses: string[];
}

export type HtmlTableImportMode = 'exact' | 'portable' | 'readable';

export interface ImportIssue {
  code: string;
  message: string;
  severity: 'info' | 'warning';
  count?: number;
}

export interface ImportStats {
  tables: number;
  rows: number;
  columns: number;
  mergedCells: number;
  images: number;
  lists: number;
}

export interface ImportVariant {
  mode: HtmlTableImportMode;
  label: string;
  markdown: string;
  issues: ImportIssue[];
}

export interface HtmlImportAnalysis {
  confluence: boolean;
  hasTables: boolean;
  stats: ImportStats;
  variants: Record<HtmlTableImportMode, ImportVariant>;
  losses: string[];
}

interface NormalizedHtml {
  document: Document;
  confluence: boolean;
  stats: ImportStats;
  issues: ImportIssue[];
  losses: string[];
}

interface GridPlacement {
  element: HTMLTableCellElement;
  row: number;
  column: number;
  colspan: number;
  rowspan: number;
  text: string;
}

interface TableGrid {
  rows: HTMLTableRowElement[];
  cells: Array<Array<GridPlacement | undefined>>;
  origins: GridPlacement[][];
  width: number;
  headerRows: number;
}

interface SemanticTable {
  fieldStart: number;
  fieldWidth: number;
  typeColumn: number;
  descriptionColumn: number;
  stateColumns: number[];
  propertyColumn: number;
  ruleColumn: number;
  stateHeaders: string[];
}

const IMPORT_LABELS: Record<HtmlTableImportMode, string> = {
  exact: 'Точный HTML',
  portable: 'Переносимый GFM',
  readable: 'Читаемый Markdown',
};

const EMOTICONS: Record<string, string> = {
  minus: '⛔',
  forbidden: '⛔',
  tick: '✅',
  check: '✅',
  plus: '➕',
  warning: '⚠️',
  information: 'ℹ️',
  info: 'ℹ️',
};

function text(value: string | null | undefined): string {
  return (value || '').replace(/\u00a0/gu, ' ').replace(/[ \t\f\v]+/gu, ' ').replace(/\s*\n\s*/gu, ' ').trim();
}

function color(value: string | null | undefined): string | null {
  const normalized = text(value).toLowerCase();
  const named: Record<string, string> = {grey: '#f4f5f7', gray: '#f4f5f7', yellow: '#fff0b3', red: '#ffebe6', green: '#e3fcef', blue: '#deebff'};
  if (named[normalized]) return named[normalized];
  if (/^#[0-9a-f]{3,8}$/iu.test(normalized)) return normalized;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/iu.test(normalized)) return normalized;
  return null;
}

function issue(code: string, message: string, severity: ImportIssue['severity'], count?: number): ImportIssue {
  return {code, message, severity, ...(count ? {count} : {})};
}

function normalizeConfluenceHtml(html: string): NormalizedHtml {
  const source = new DOMParser().parseFromString(html, 'text/html');
  const confluence = Boolean(source.querySelector('.confluenceTable,.confluenceTd,.confluenceTh,[data-macro-name],[data-highlight-colour]'));
  const tables = Array.from(source.querySelectorAll('table')) as HTMLTableElement[];
  const rows = tables.reduce((sum, table) => sum + table.rows.length, 0);
  const columns = tables.reduce((maximum, table) => Math.max(maximum, tableGrid(table).width), 0);
  const mergedCells = source.querySelectorAll('td[rowspan],td[colspan],th[rowspan],th[colspan]').length;
  const images = source.querySelectorAll('img').length;
  const lists = source.querySelectorAll('ul,ol').length;
  const activeObjects = source.querySelectorAll('script,style,iframe,video,object,embed,svg,form').length;
  let eventAttributes = 0;
  source.querySelectorAll('*').forEach((element) => {
    eventAttributes += Array.from(element.attributes).filter((attr) => /^on/iu.test(attr.name)).length;
  });
  const outsideColors = Array.from(source.querySelectorAll<HTMLElement>('[style]')).filter((element) => !element.closest('table') && Boolean(element.style.color || element.style.backgroundColor)).length;
  const issues: ImportIssue[] = [];
  const losses: string[] = [];
  if (activeObjects) {
    issues.push(issue('active-content-removed', 'Удалены активные или встроенные объекты', 'warning', activeObjects));
    losses.push('встроенные объекты');
  }
  if (eventAttributes) issues.push(issue('event-handlers-removed', 'Удалены обработчики событий Confluence', 'info', eventAttributes));
  if (outsideColors) {
    issues.push(issue('non-table-colors-removed', 'Цветовое оформление вне таблиц не переносится', 'warning', outsideColors));
    losses.push('цветовое оформление');
  }

  for (const expandable of Array.from(source.querySelectorAll<HTMLElement>('[data-macro-name="ui-expand"],.rwui_expandable_item'))) {
    if (!expandable.isConnected) continue;
    const titleNode = expandable.querySelector<HTMLElement>('.rwui_expandable_item_title');
    const titleClone = titleNode?.cloneNode(true) as HTMLElement | undefined;
    titleClone?.querySelectorAll('div,span[aria-hidden="true"]').forEach((node) => node.remove());
    const title = text(titleClone?.textContent);
    const body = expandable.querySelector<HTMLElement>('.rwui_expandable_item_body');
    const fragment = source.createDocumentFragment();
    if (title) {
      const paragraph = source.createElement('p');
      const strong = source.createElement('strong');
      strong.textContent = title;
      paragraph.append(strong);
      fragment.append(paragraph);
    }
    if (body) Array.from(body.childNodes).forEach((node) => fragment.append(node.cloneNode(true)));
    expandable.replaceWith(fragment);
  }

  let normalizedTips = 0;
  for (const macro of Array.from(source.querySelectorAll<HTMLElement>('[data-macro-name="tip"]'))) {
    const body = macro.querySelector<HTMLElement>('.confluence-information-macro-body') || macro;
    const replacement = source.createElement('div');
    replacement.className = 'fortis-table-tip';
    replacement.setAttribute('data-alert', 'TIP');
    Array.from(body.childNodes).forEach((node) => replacement.append(node.cloneNode(true)));
    macro.replaceWith(replacement);
    normalizedTips += 1;
  }
  if (normalizedTips) issues.push(issue('tip-normalized', 'Информационные блоки Confluence преобразованы в FORTIS TIP', 'info', normalizedTips));

  let normalizedIcons = 0;
  let replacedImages = 0;
  for (const image of Array.from(source.querySelectorAll<HTMLImageElement>('img'))) {
    const name = (image.dataset.emoticonName || '').toLowerCase();
    const fallback = text(image.alt);
    const known = EMOTICONS[name] || (/минус|forbidden/iu.test(fallback) ? '⛔' : '');
    image.replaceWith(source.createTextNode(known || fallback || 'Изображение'));
    if (known) normalizedIcons += 1;
    else replacedImages += 1;
  }
  if (normalizedIcons) issues.push(issue('emoticons-normalized', 'Иконки Confluence заменены переносимыми символами', 'info', normalizedIcons));
  if (replacedImages) {
    issues.push(issue('images-replaced', 'Изображения заменены alt-текстом для автономной работы', 'warning', replacedImages));
    losses.push(`изображения (${replacedImages})`);
  }

  for (const cell of Array.from(source.querySelectorAll<HTMLTableCellElement>('th,td'))) {
    const background = color(cell.dataset.highlightColour || cell.style.backgroundColor);
    const foregroundSource = Array.from(cell.querySelectorAll<HTMLElement>('[style]')).map((element) => color(element.style.color)).find(Boolean);
    const foreground = color(cell.style.color) || foregroundSource || null;
    if (background) cell.style.backgroundColor = background;
    if (foreground) cell.style.color = foreground;
  }

  source.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/iu.test(attr.name)
        || ['contenteditable', 'resolved', 'data-ref', 'data-highlight-colour', 'data-macro-name', 'data-hasbody'].includes(attr.name)) element.removeAttribute(attr.name);
    }
    if (element.classList.length) {
      const retained = Array.from(element.classList).filter((name) => name.startsWith('fortis-'));
      if (retained.length) element.className = retained.join(' ');
      else element.removeAttribute('class');
    }
  });

  const clean = sanitizeHtml(source.body.innerHTML);
  return {
    document: new DOMParser().parseFromString(clean, 'text/html'),
    confluence,
    stats: {tables: tables.length, rows, columns, mergedCells, images, lists},
    issues,
    losses: Array.from(new Set(losses)),
  };
}

function turndownFor(mode: HtmlTableImportMode, issues: ImportIssue[]): TurndownService {
  const turndown = new TurndownService({
    headingStyle: PORTABLE_MARKDOWN_POLICY.headingStyle,
    bulletListMarker: PORTABLE_MARKDOWN_POLICY.bulletListMarker,
    codeBlockStyle: PORTABLE_MARKDOWN_POLICY.codeBlockStyle,
  });
  turndown.use(gfm);
  turndown.addRule('fortis-alert', {
    filter: (node) => node.nodeType === 1 && (node as HTMLElement).hasAttribute('data-alert'),
    replacement(content, node) {
      const type = ((node as HTMLElement).getAttribute('data-alert') || 'NOTE').toUpperCase();
      return `\n\n> [!${type}]\n${content.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
    },
  });
  if (mode === 'exact') {
    turndown.addRule('complex-table', {
      filter: (node) => node.nodeName === 'TABLE' && isComplexTable(node as HTMLTableElement),
      replacement(_content, node) {
        return `\n\n${sanitizeHtml((node as HTMLElement).outerHTML)}\n\n`;
      },
    });
  } else {
    turndown.addRule(`${mode}-table`, {
      filter: (node) => node.nodeName === 'TABLE',
      replacement(_content, node) {
        const table = node as HTMLTableElement;
        if (mode === 'portable') return `\n\n${portableTable(table)}\n\n`;
        const readable = readableTable(table);
        if (readable) return `\n\n${readable}\n\n`;
        issues.push(issue('readable-fallback', 'Структура таблицы не распознана — использован переносимый GFM', 'warning'));
        return `\n\n${portableTable(table)}\n\n`;
      },
    });
  }
  return turndown;
}

function markdownFromDocument(documentNode: Document, mode: HtmlTableImportMode, issues: ImportIssue[]): string {
  const turndown = turndownFor(mode, issues);
  return turndown.turndown(documentNode.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function isComplexTable(table: HTMLTableElement): boolean {
  const grid = tableGrid(table);
  return Boolean(
    table.matches('[width],[style*="width"],[style*="background"],[style*="color"]')
    || table.querySelector('colgroup,[rowspan],[colspan],[width],[style*="width"],[style*="background"],[style*="color"],td p,th p,td ul,th ul,td ol,th ol,td div,th div')
    || grid.headerRows > 1
  );
}

function portableNode(node: Node, listDepth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ');
  if (!(node instanceof Element)) return '';
  const children = () => Array.from(node.childNodes).map((child) => portableNode(child, listDepth)).join('');
  switch (node.tagName) {
    case 'BR': return '<br>';
    case 'STRONG': case 'B': return `**${text(children())}**`;
    case 'EM': case 'I': return `*${text(children())}*`;
    case 'DEL': case 'S': return `~~${text(children())}~~`;
    case 'CODE': return `\`${text(children()).replace(/`/gu, '\\`')}\``;
    case 'A': {
      const label = text(children());
      const href = node.getAttribute('href') || '';
      return href ? `[${label}](${href})` : label;
    }
    case 'UL': case 'OL': {
      const ordered = node.tagName === 'OL';
      return Array.from(node.children).filter((child) => child.tagName === 'LI').map((child, index) => {
        const own = Array.from(child.childNodes).filter((part) => !(part instanceof Element && /^(UL|OL)$/u.test(part.tagName))).map((part) => portableNode(part, listDepth + 1)).join('');
        const nested = Array.from(child.children).filter((part) => /^(UL|OL)$/u.test(part.tagName)).map((part) => portableNode(part, listDepth + 1)).join('<br>');
        const marker = ordered ? `${index + 1}.` : listDepth ? '◦' : '•';
        return `${marker} ${text(own)}${nested ? `<br>${nested}` : ''}`;
      }).join('<br>');
    }
    case 'LI': return text(children());
    case 'P': case 'DIV': case 'ASIDE': {
      const prefix = node.classList.contains('fortis-table-tip') ? '**TIP:**<br>' : '';
      return `${prefix}${children()}<br>`;
    }
    default: return children();
  }
}

function portableCell(element: Element): string {
  return Array.from(element.childNodes).map((node) => portableNode(node)).join('')
    .replace(/(?:<br>\s*)+$/gu, '')
    .replace(/^(?:\s*<br>)+/gu, '')
    .replace(/\s*(<br>)\s*/gu, '$1')
    .trim();
}

function plainPortable(value: string): string {
  const doc = new DOMParser().parseFromString(value.replace(/<br>/giu, ' '), 'text/html');
  return text(doc.body.textContent).replace(/\*\*|~~|`/gu, '');
}

function tableGrid(table: HTMLTableElement): TableGrid {
  const rows = Array.from(table.rows);
  const cells: Array<Array<GridPlacement | undefined>> = rows.map(() => []);
  const origins: GridPlacement[][] = rows.map(() => []);
  let width = 0;
  rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const child of Array.from(row.cells)) {
      while (cells[rowIndex][column]) column += 1;
      const colspan = Math.max(1, child.colSpan || 1);
      const rowspan = Math.max(1, child.rowSpan || 1);
      const placement: GridPlacement = {element: child, row: rowIndex, column, colspan, rowspan, text: portableCell(child)};
      origins[rowIndex].push(placement);
      for (let y = rowIndex; y < Math.min(rows.length, rowIndex + rowspan); y += 1) {
        for (let x = column; x < column + colspan; x += 1) cells[y][x] = placement;
      }
      column += colspan;
      width = Math.max(width, column);
    }
  });
  let headerRows = 0;
  if (table.tHead?.rows.length) headerRows = table.tHead.rows.length;
  else if (origins[0]?.length && origins[0].every((cell) => cell.element.tagName === 'TH')) {
    headerRows = Math.max(1, ...origins[0].map((cell) => cell.rowspan));
  }
  headerRows = Math.min(rows.length, headerRows || (rows.length ? 1 : 0));
  return {rows, cells, origins, width, headerRows};
}

function headerAt(grid: TableGrid, column: number): string {
  const values: string[] = [];
  for (let row = 0; row < grid.headerRows; row += 1) {
    const value = grid.cells[row]?.[column]?.text || '';
    if (value && values.at(-1) !== value) values.push(value);
  }
  return values.join(' / ');
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/gu, '<br>').replace(/(?<!\\)\|/gu, '\\|').trim();
}

function gfmTable(headers: string[], rows: string[][]): string {
  const width = Math.max(1, headers.length, ...rows.map((row) => row.length));
  const normalize = (row: string[]) => Array.from({length: width}, (_, column) => escapeTableCell(row[column] || ''));
  return [normalize(headers), Array.from({length: width}, () => '---'), ...rows.map(normalize)]
    .map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function normalizedHeader(value: string): string {
  return plainPortable(value).toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
}

function semanticTable(grid: TableGrid): SemanticTable | null {
  const first = grid.origins[0] || [];
  const find = (pattern: RegExp) => first.find((cell) => pattern.test(normalizedHeader(cell.text)));
  const field = find(/^поле$/u);
  const typeCell = find(/^тип$/u);
  const description = find(/^описание$/u);
  const states = find(/структура входных параметров|состояни/u);
  const properties = find(/^свойства$/u);
  const rule = find(/правил.*заполн/u);
  if (!field || !typeCell || !description || !states || !properties || !rule || states.colspan < 2) return null;
  const stateColumns = Array.from({length: states.colspan}, (_, index) => states.column + index);
  return {
    fieldStart: field.column,
    fieldWidth: field.colspan,
    typeColumn: typeCell.column,
    descriptionColumn: description.column,
    stateColumns,
    propertyColumn: properties.column,
    ruleColumn: rule.column,
    stateHeaders: stateColumns.map((column) => {
      const values = Array.from({length: grid.headerRows}, (_, row) => grid.cells[row]?.[column]?.text || '').filter(Boolean);
      return values.at(-1) || `Состояние ${column - states.column + 1}`;
    }),
  };
}

function semanticRows(grid: TableGrid, semantic: SemanticTable): Array<{field: string; values: string[]}> {
  const stack: Array<string | undefined> = [];
  const rows: Array<{field: string; values: string[]}> = [];
  for (let row = grid.headerRows; row < grid.rows.length; row += 1) {
    const fieldEnd = semantic.fieldStart + semantic.fieldWidth;
    const fields = grid.origins[row].filter((cell) => cell.column >= semantic.fieldStart && cell.column < fieldEnd && plainPortable(cell.text));
    for (const field of fields) {
      const level = field.column - semantic.fieldStart;
      stack[level] = plainPortable(field.text);
      stack.splice(level + 1);
    }
    let path = '';
    for (const segment of stack.filter((value): value is string => Boolean(value))) {
      if (!path) path = segment;
      else if (segment.startsWith(`${path}.`) || segment.startsWith(`${path}[`)) path = segment;
      else path = `${path}.${segment}`;
    }
    const columns = [semantic.typeColumn, semantic.descriptionColumn, ...semantic.stateColumns, semantic.propertyColumn, semantic.ruleColumn];
    rows.push({field: path, values: columns.map((column) => grid.cells[row]?.[column]?.text || '')});
  }
  return rows;
}

function portableTable(table: HTMLTableElement): string {
  const grid = tableGrid(table);
  if (!grid.rows.length) return '';
  const semantic = semanticTable(grid);
  if (semantic) {
    const headers = ['Поле', 'Тип', 'Описание', ...semantic.stateHeaders, 'Свойства', 'Правило заполнения параметров'];
    const rows = semanticRows(grid, semantic).map((row) => [row.field, ...row.values]);
    return gfmTable(headers, rows);
  }
  const headers = Array.from({length: grid.width}, (_, column) => headerAt(grid, column) || `Столбец ${column + 1}`);
  const rows = Array.from({length: Math.max(0, grid.rows.length - grid.headerRows)}, (_, offset) => {
    const row = offset + grid.headerRows;
    return Array.from({length: grid.width}, (_, column) => grid.cells[row]?.[column]?.text || '');
  });
  return gfmTable(headers, rows);
}

function readableTable(table: HTMLTableElement): string | null {
  const grid = tableGrid(table);
  const semantic = semanticTable(grid);
  if (!semantic) return null;
  const rows = semanticRows(grid, semantic).filter((row) => row.field);
  const catalogRows = rows.map((row) => [row.field, row.values[0], row.values[1], row.values.at(-2) || '', row.values.at(-1) || '']);
  const matrixRows = rows.map((row) => [row.field, ...row.values.slice(2, 2 + semantic.stateColumns.length)]);
  return [
    '### Каталог полей',
    '',
    gfmTable(['Поле', 'Тип', 'Описание', 'Свойства', 'Правило заполнения параметров'], catalogRows),
    '',
    '### Матрица состояний',
    '',
    gfmTable(['Поле', ...semantic.stateHeaders], matrixRows),
  ].join('\n');
}

export function analyzeHtmlImport(html: string): HtmlImportAnalysis {
  const normalized = normalizeConfluenceHtml(html);
  const modes: HtmlTableImportMode[] = ['exact', 'portable', 'readable'];
  const variants = Object.fromEntries(modes.map((mode) => {
    const issues = normalized.issues.map((item) => ({...item}));
    if (mode === 'portable' && normalized.stats.tables) issues.push(issue('structure-flattened', 'Объединённые ячейки развёрнуты в переносимую сетку', 'info'));
    if (mode === 'readable' && normalized.stats.tables) issues.push(issue('tables-restructured', 'Широкие таблицы разделены на каталог полей и матрицу состояний', 'info'));
    const markdown = markdownFromDocument(normalized.document, mode, issues);
    return [mode, {mode, label: IMPORT_LABELS[mode], markdown, issues} satisfies ImportVariant];
  })) as Record<HtmlTableImportMode, ImportVariant>;
  return {
    confluence: normalized.confluence,
    hasTables: normalized.stats.tables > 0,
    stats: normalized.stats,
    variants,
    losses: normalized.losses,
  };
}

export function htmlToMarkdown(html: string): ImportResult {
  const analysis = analyzeHtmlImport(html);
  return {markdown: analysis.variants.exact.markdown, losses: analysis.losses};
}

export async function docxToMarkdown(buffer: ArrayBuffer): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('Файл не является документом Word');
  const xml = new DOMParser().parseFromString(await documentFile.async('string'), 'application/xml');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const losses: string[] = [];
  const media = Object.keys(zip.files).filter((name) => /^word\/media\//.test(name));
  if (media.length) losses.push(`изображения (${media.length})`);
  if (xml.querySelector('parsererror')) throw new Error('Повреждённый XML внутри DOCX');

  const lines: string[] = [];
  const body = xml.getElementsByTagNameNS(ns, 'body')[0];
  if (!body) throw new Error('Документ пуст');
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    if (element.localName === 'tbl') {
      const rows = Array.from(element.getElementsByTagNameNS(ns, 'tr')).map((row) => Array.from(row.getElementsByTagNameNS(ns, 'tc')).map((cell) => paragraphText(cell, ns)));
      if (rows.length) {
        lines.push(`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`), '');
      }
      continue;
    }
    if (element.localName !== 'p') continue;
    const style = element.getElementsByTagNameNS(ns, 'pStyle')[0]?.getAttributeNS(ns, 'val') || '';
    const text = paragraphText(element, ns);
    if (!text) { lines.push(''); continue; }
    const heading = style.match(/Heading(\d)/i);
    lines.push(heading ? `${'#'.repeat(Number(heading[1]))} ${text}` : text, '');
  }
  return {markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', losses};
}

function paragraphText(root: Element, ns: string): string {
  let result = '';
  for (const run of Array.from(root.getElementsByTagNameNS(ns, 'r'))) {
    let text = Array.from(run.getElementsByTagNameNS(ns, 't')).map((item) => item.textContent || '').join('');
    if (!text) continue;
    const props = run.getElementsByTagNameNS(ns, 'rPr')[0];
    if (props?.getElementsByTagNameNS(ns, 'b').length) text = `**${text}**`;
    if (props?.getElementsByTagNameNS(ns, 'i').length) text = `*${text}*`;
    if (props?.getElementsByTagNameNS(ns, 'strike').length) text = `~~${text}~~`;
    result += text;
  }
  return result.trim().replace(/\|/g, '\\|');
}
