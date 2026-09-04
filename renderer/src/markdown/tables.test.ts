import {describe, expect, it} from 'vitest';
import {extractTables, mergeTableCells, replaceTable, serializeTable, splitTableCell} from './tables';

describe('portable tables', () => {
  it('keeps simple tables in GFM', () => {
    const markdown = '| Имя | Статус |\n| :--- | ---: |\n| FORTIS | готов |\n';
    const [table] = extractTables(markdown);
    expect(table.complex).toBe(false);
    expect(serializeTable(table)).toContain('| Имя | Статус |');
    expect(serializeTable(table)).not.toContain('#|');
  });

  it('round-trips colspan, rowspan, alignment and width as sanitized HTML', () => {
    const markdown = '<table>\n<thead><tr><th colspan="2">Заголовок</th></tr></thead>\n<tbody><tr><td rowspan="2" style="text-align:center;width:40%"><strong>A</strong></td><td>B</td></tr><tr><td><em>C</em></td></tr></tbody>\n</table>';
    const [table] = extractTables(markdown);
    expect(table.rows[0][0].colspan).toBe(2);
    expect(table.rows[1][0]).toMatchObject({rowspan: 2, align: 'center', width: '40%'});
    const output = replaceTable(markdown, table);
    expect(output).toContain('colspan="2"');
    expect(output).toContain('rowspan="2"');
    expect(output).toContain('width:40%');
    expect(output).toContain('<strong>A</strong>');
    expect(output).toContain('<em>C</em>');
    expect(output).not.toContain('{%');
  });

  it('round-trips colgroup, safe colors and rich cell HTML until that cell is edited', () => {
    const markdown = '<table style="width:90%"><colgroup><col style="width:30%"><col style="width:70%"></colgroup><tbody><tr><th>A</th><th>B</th></tr><tr><td style="background-color:#f4f5f7;color:rgb(0,51,102)"><ul><li>Один</li><li>Два</li></ul></td><td>Текст</td></tr></tbody></table>';
    const [table] = extractTables(markdown);
    expect(table.width).toBe('90%');
    expect(table.columnWidths).toEqual(['30%', '70%']);
    expect(table.rows[1][0]).toMatchObject({background: 'rgb(244, 245, 247)', color: 'rgb(0, 51, 102)'});
    const untouched = serializeTable(table);
    expect(untouched).toContain('<colgroup>');
    expect(untouched).toContain('<ul>');
    expect(untouched).toContain('background-color:rgb(244, 245, 247)');

    table.rows[1][0].text = 'Изменено';
    table.rows[1][0].html = undefined;
    const edited = serializeTable(table);
    expect(edited).toContain('>Изменено</td>');
    expect(edited).not.toContain('<ul>');
    expect(edited).toContain('background-color:rgb(244, 245, 247)');
  });

  it('merges and splits a rectangular selection', () => {
    const table = extractTables('| A | B |\n| --- | --- |\n| C | D |')[0];
    const merged = mergeTableCells(table, ['1:0', '1:1']);
    expect(serializeTable(merged)).toContain('colspan="2"');
    const split = splitTableCell(merged, '1:0');
    expect(split.rows[1]).toHaveLength(2);
    expect(split.rows[1][0]).toMatchObject({colspan: 1, rowspan: 1});
  });
});
