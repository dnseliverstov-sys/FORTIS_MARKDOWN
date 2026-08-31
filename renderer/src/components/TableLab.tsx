import {useMemo, useState} from 'react';
import {
  createPortableTable, extractTables, mergeTableCells, replaceTable, serializeTable,
  splitTableCell, type PortableTable,
} from '../markdown/tables';
import {Modal} from './Modal';

interface Props {
  markdown: string;
  onApply(markdown: string): void;
  onClose(): void;
}

function cloneTable(table: PortableTable): PortableTable {
  return {...table, rows: table.rows.map((row) => row.map((cell) => ({...cell})))};
}

export function TableLab({markdown, onApply, onClose}: Props) {
  const sourceTables = useMemo(() => extractTables(markdown), [markdown]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<PortableTable>(() => cloneTable(sourceTables[0] || createPortableTable()));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [tableError, setTableError] = useState('');
  const existing = Boolean(sourceTables[index]);

  const update = (fn: (table: PortableTable) => void) => setDraft((current) => {
    const next = cloneTable(current); fn(next); return next;
  });
  const columns = Math.max(1, ...draft.rows.map((row) => row.length));

  return (
    <Modal title="Редактор переносимой таблицы" onClose={onClose} wide footer={<>
      <button type="button" onClick={onClose}>Отмена</button>
      <button type="button" className="primary" onClick={() => {
        const replacement = existing ? replaceTable(markdown, draft) : `${markdown.replace(/\s*$/, '')}\n\n${serializeTable(draft)}\n`;
        onApply(replacement);
      }}>{existing ? 'Применить' : 'Вставить'}</button>
    </>}>
      <div className="table-lab-toolbar">
        {sourceTables.length ? <select value={index} onChange={(event) => {
          const next = Number(event.target.value); setIndex(next); setDraft(cloneTable(sourceTables[next])); setSelected(new Set());
        }}>{sourceTables.map((_, tableIndex) => <option value={tableIndex} key={tableIndex}>Таблица {tableIndex + 1}</option>)}</select> : <span>В документе нет таблиц — будет создана новая.</span>}
        <button type="button" onClick={() => update((table) => {
          table.rows.push(Array.from({length: columns}, (_, column) => ({
            text: 'Значение', header: false, colspan: 1, rowspan: 1,
            align: table.rows[0]?.[column]?.align || 'left',
          })));
        })}>+ строка</button>
        <button type="button" onClick={() => update((table) => {
          table.rows.forEach((row, rowIndex) => row.push({
            text: rowIndex === 0 ? `Столбец ${row.length + 1}` : 'Значение',
            header: rowIndex === 0, colspan: 1, rowspan: 1, align: 'left',
          }));
        })}>+ столбец</button>
        <button type="button" disabled={draft.rows.length <= 2} onClick={() => update((table) => table.rows.pop())}>− строка</button>
        <button type="button" disabled={columns <= 1} onClick={() => update((table) => table.rows.forEach((row) => row.pop()))}>− столбец</button>
        <button type="button" disabled={selected.size < 2} onClick={() => {
          try {setDraft(mergeTableCells(draft, Array.from(selected))); setSelected(new Set()); setTableError('');}
          catch (error) {setTableError(error instanceof Error ? error.message : String(error));}
        }}>Объединить</button>
        <button type="button" disabled={selected.size !== 1} onClick={() => {
          try {setDraft(splitTableCell(draft, Array.from(selected)[0])); setSelected(new Set()); setTableError('');}
          catch (error) {setTableError(error instanceof Error ? error.message : String(error));}
        }}>Разделить</button>
        <label><input type="checkbox" checked={draft.complex} onChange={(event) => update((table) => {table.complex = event.target.checked;})} /> HTML-таблица</label>
      </div>
      <div className="table-lab-grid">
        {draft.rows.map((row, rowIndex) => row.map((cell, columnIndex) => (
          <div className="table-lab-cell" key={`${rowIndex}-${columnIndex}`}>
            <label className="table-cell-select"><input type="checkbox" checked={selected.has(`${rowIndex}:${columnIndex}`)} onChange={(event) => setSelected((current) => {
              const next = new Set(current); const key = `${rowIndex}:${columnIndex}`;
              if (event.target.checked) next.add(key); else next.delete(key);
              return next;
            })} /> ячейка {rowIndex + 1}:{columnIndex + 1}</label>
            <textarea value={cell.text} onChange={(event) => update((table) => {table.rows[rowIndex][columnIndex].text = event.target.value; table.rows[rowIndex][columnIndex].html = undefined;})} />
            <div>
              <select value={cell.align} onChange={(event) => update((table) => {table.rows[rowIndex][columnIndex].align = event.target.value as typeof cell.align;})}>
                <option value="left">слева</option><option value="center">центр</option><option value="right">справа</option>
              </select>
              <label>↔ <input type="number" min="1" max="12" value={cell.colspan} onChange={(event) => update((table) => {table.rows[rowIndex][columnIndex].colspan = Math.max(1, Number(event.target.value)); table.complex = true;})} /></label>
              <label>↕ <input type="number" min="1" max="50" value={cell.rowspan} onChange={(event) => update((table) => {table.rows[rowIndex][columnIndex].rowspan = Math.max(1, Number(event.target.value)); table.complex = true;})} /></label>
              <input className="width-input" placeholder="ширина" value={cell.width || ''} onChange={(event) => update((table) => {table.rows[rowIndex][columnIndex].width = event.target.value || undefined; if (event.target.value) table.complex = true;})} />
            </div>
          </div>
        )))}
      </div>
      {tableError ? <div className="warning-box">{tableError}</div> : null}
      <p className="modal-note">Простая таблица сохраняется как GFM. Объединения и ширина автоматически включают переносимый HTML с очищенными атрибутами.</p>
    </Modal>
  );
}
