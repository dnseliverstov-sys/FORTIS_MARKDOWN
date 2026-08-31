import {sanitizeHtml} from './pipeline';

export interface PortableCell {
  text: string;
  /** Sanitized inline HTML retained until the user edits the cell text. */
  html?: string;
  header: boolean;
  colspan: number;
  rowspan: number;
  align: 'left' | 'center' | 'right';
  width?: string;
}

export interface PortableTable {
  source: string;
  start: number;
  end: number;
  rows: PortableCell[][];
  complex: boolean;
}

interface CellPlacement {
  key: string;
  rowIndex: number;
  cellIndex: number;
  column: number;
  cell: PortableCell;
}

function tableLayout(table: PortableTable): {placements: CellPlacement[]; grid: Array<Array<CellPlacement | undefined>>} {
  const grid: Array<Array<CellPlacement | undefined>> = [];
  const placements: CellPlacement[] = [];
  table.rows.forEach((row, rowIndex) => {
    grid[rowIndex] ||= [];
    let column = 0;
    row.forEach((cell, cellIndex) => {
      while (grid[rowIndex][column]) column += 1;
      const placement = {key: `${rowIndex}:${cellIndex}`, rowIndex, cellIndex, column, cell};
      placements.push(placement);
      for (let y = rowIndex; y < rowIndex + Math.max(1, cell.rowspan); y += 1) {
        grid[y] ||= [];
        for (let x = column; x < column + Math.max(1, cell.colspan); x += 1) grid[y][x] = placement;
      }
      column += Math.max(1, cell.colspan);
    });
  });
  return {placements, grid};
}

function rebuildRows(table: PortableTable, placements: CellPlacement[]): void {
  table.rows = table.rows.map((_, rowIndex) => placements
    .filter((placement) => placement.rowIndex === rowIndex)
    .sort((left, right) => left.column - right.column)
    .map((placement) => placement.cell));
}

export function mergeTableCells(table: PortableTable, selectedKeys: string[]): PortableTable {
  const next: PortableTable = {...table, rows: table.rows.map((row) => row.map((cell) => ({...cell}))), complex: true};
  const {placements, grid} = tableLayout(next);
  const selected = placements.filter((placement) => selectedKeys.includes(placement.key));
  if (selected.length < 2) throw new Error('Выберите минимум две ячейки');
  const minRow = Math.min(...selected.map((placement) => placement.rowIndex));
  const maxRow = Math.max(...selected.map((placement) => placement.rowIndex + placement.cell.rowspan - 1));
  const minColumn = Math.min(...selected.map((placement) => placement.column));
  const maxColumn = Math.max(...selected.map((placement) => placement.column + placement.cell.colspan - 1));
  const selectedSet = new Set(selected);
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const placement = grid[row]?.[column];
      if (!placement || !selectedSet.has(placement)) throw new Error('Ячейки должны образовывать прямоугольник');
    }
  }
  const origin = selected.find((placement) => placement.rowIndex === minRow && placement.column === minColumn);
  if (!origin) throw new Error('Не найдена верхняя левая ячейка');
  origin.cell.colspan = maxColumn - minColumn + 1;
  origin.cell.rowspan = maxRow - minRow + 1;
  origin.cell.text = selected.map((placement) => placement.cell.text).filter(Boolean).join(' ');
  origin.cell.html = undefined;
  rebuildRows(next, placements.filter((placement) => !selectedSet.has(placement) || placement === origin));
  return next;
}

export function splitTableCell(table: PortableTable, selectedKey: string): PortableTable {
  const next: PortableTable = {...table, rows: table.rows.map((row) => row.map((cell) => ({...cell}))), complex: true};
  const {placements} = tableLayout(next);
  const selected = placements.find((placement) => placement.key === selectedKey);
  if (!selected || (selected.cell.colspan <= 1 && selected.cell.rowspan <= 1)) throw new Error('Выберите объединённую ячейку');
  const oldColspan = selected.cell.colspan;
  const oldRowspan = selected.cell.rowspan;
  selected.cell.colspan = 1;
  selected.cell.rowspan = 1;
  const additions: CellPlacement[] = [];
  for (let row = selected.rowIndex; row < selected.rowIndex + oldRowspan; row += 1) {
    for (let column = selected.column; column < selected.column + oldColspan; column += 1) {
      if (row === selected.rowIndex && column === selected.column) continue;
      additions.push({
        key: `new:${row}:${column}`,
        rowIndex: row,
        cellIndex: Number.MAX_SAFE_INTEGER,
        column,
        cell: {text: '', header: row === 0, colspan: 1, rowspan: 1, align: selected.cell.align},
      });
    }
  }
  rebuildRows(next, [...placements, ...additions]);
  return next;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function safeCellHtml(cell: PortableCell): string {
  const tag = cell.header ? 'th' : 'td';
  const attrs = [
    cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '',
    cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '',
    cell.align !== 'left' ? ` style="text-align:${cell.align}${cell.width ? `;width:${cell.width}` : ''}"` : cell.width ? ` style="width:${cell.width}"` : '',
  ].join('');
  const content = cell.html ?? cell.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return `<${tag}${attrs}>${content}</${tag}>`;
}

export function serializeTable(table: PortableTable): string {
  const complex = table.complex || table.rows.some((row) => row.some((cell) => cell.colspan > 1 || cell.rowspan > 1 || cell.width));
  if (!complex && table.rows.length) {
    const [head, ...body] = table.rows;
    const divider = head.map((cell) => cell.align === 'center' ? ':---:' : cell.align === 'right' ? '---:' : ':---');
    return [head.map((cell) => escapeCell(cell.text)), divider, ...body.map((row) => row.map((cell) => escapeCell(cell.text)))]
      .map((row) => `| ${row.join(' | ')} |`).join('\n');
  }
  const headRows = table.rows.filter((row) => row.some((cell) => cell.header));
  const bodyRows = table.rows.filter((row) => !row.some((cell) => cell.header));
  const renderRows = (rows: PortableCell[][]) => rows.map((row) => `  <tr>${row.map(safeCellHtml).join('')}</tr>`).join('\n');
  const html = [
    '<table>',
    ...(headRows.length ? [' <thead>', renderRows(headRows), ' </thead>'] : []),
    ' <tbody>',
    renderRows(bodyRows.length ? bodyRows : headRows),
    ' </tbody>',
    '</table>',
  ].join('\n');
  return sanitizeHtml(html);
}

function htmlTable(source: string, start: number): PortableTable | null {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll('tr')).map((row) => Array.from(row.children).filter((cell) => /^(TD|TH)$/.test(cell.tagName)).map((cell) => {
    const element = cell as HTMLTableCellElement;
    const style = element.style;
    return {
      text: inlineHtmlToMarkdown(element),
      html: sanitizeHtml(element.innerHTML),
      header: element.tagName === 'TH',
      colspan: Math.max(1, element.colSpan || 1),
      rowspan: Math.max(1, element.rowSpan || 1),
      align: (style.textAlign === 'center' || style.textAlign === 'right' ? style.textAlign : 'left') as PortableCell['align'],
      width: style.width || element.getAttribute('width') || undefined,
    };
  }));
  return {source, start, end: start + source.length, rows, complex: true};
}

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

function pipeTable(source: string, start: number): PortableTable | null {
  const lines = source.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const split = (line: string) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const header = split(lines[0]);
  const alignments = split(lines[1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left') as PortableCell['align'][];
  const rows = [header, ...lines.slice(2).map(split)].map((values, rowIndex) => values.map((text, column) => ({
    text, header: rowIndex === 0, colspan: 1, rowspan: 1, align: alignments[column] || 'left',
  })));
  return {source, start, end: start + source.length, rows, complex: false};
}

export function extractTables(markdown: string): PortableTable[] {
  const found: PortableTable[] = [];
  for (const match of markdown.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const table = htmlTable(match[0], match.index || 0);
    if (table) found.push(table);
  }
  for (const match of markdown.matchAll(/^(?:\s*\|.*\|\s*\r?\n)(?:\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*\r?\n)(?:(?:\s*\|.*\|\s*)(?:\r?\n|$))*/gm)) {
    if (found.some((item) => (match.index || 0) >= item.start && (match.index || 0) < item.end)) continue;
    const table = pipeTable(match[0], match.index || 0);
    if (table) found.push(table);
  }
  return found.sort((a, b) => a.start - b.start);
}

export function replaceTable(markdown: string, table: PortableTable): string {
  return markdown.slice(0, table.start) + serializeTable(table) + markdown.slice(table.end);
}

export function createPortableTable(rows = 2, columns = 2): PortableTable {
  return {
    source: '', start: 0, end: 0, complex: false,
    rows: Array.from({length: rows}, (_, row) => Array.from({length: columns}, (_, column) => ({
      text: row === 0 ? `Столбец ${column + 1}` : 'Значение', header: row === 0,
      colspan: 1, rowspan: 1, align: 'left' as const,
    }))),
  };
}
