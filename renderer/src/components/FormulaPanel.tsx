import {useEffect, useRef, useState} from 'react';
import katex from 'katex';
import {sanitizeRenderedHtml} from '../markdown/pipeline';

export interface FormulaEdit {
  tex: string;
  block: boolean;
  existing: boolean;
  apply(tex: string, block: boolean): void;
  remove?(): void;
}

export const FORMULA_SNIPPETS = [
  {id: 'frac', label: 'дробь', code: '\\frac{a}{b}'},
  {id: 'pow', label: 'x²', code: 'x^{2}'},
  {id: 'sub', label: 'xᵢ', code: 'x_{i}'},
  {id: 'sqrt', label: '√', code: '\\sqrt{x}'},
  {id: 'sum', label: '∑', code: '\\sum_{i=1}^{n} '},
  {id: 'int', label: '∫', code: '\\int_{a}^{b} '},
  {id: 'alpha', label: 'α', code: '\\alpha '},
  {id: 'beta', label: 'β', code: '\\beta '},
  {id: 'pi', label: 'π', code: '\\pi '},
  {id: 'le', label: '≤', code: '\\le '},
  {id: 'ge', label: '≥', code: '\\ge '},
  {id: 'times', label: '×', code: '\\times '},
  {id: 'approx', label: '≈', code: '\\approx '},
] as const;

export function FormulaPanel({edit, onClose}: {edit: FormulaEdit; onClose(): void}) {
  const [tex, setTex] = useState(edit.tex);
  const [block, setBlock] = useState(edit.block);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {inputRef.current?.focus();}, []);
  let preview = '';
  try {preview = sanitizeRenderedHtml(katex.renderToString(tex || '\\square', {displayMode: false, throwOnError: false}));}
  catch {preview = '<span class="math-error">ошибка в формуле</span>';}

  const insertSnippet = (code: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? tex.length;
    const end = input?.selectionEnd ?? start;
    const next = tex.slice(0, start) + code + tex.slice(end);
    setTex(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + code.length, start + code.length);
    });
  };

  return <section className="formula-panel" aria-label="Редактор формулы">
    <div className="formula-main-row">
      <strong>Формула</strong>
      <input ref={inputRef} className="formula-input" value={tex} onChange={(event) => setTex(event.target.value)} placeholder="\\frac{n(n+1)}{2}" />
      <div className="formula-preview" dangerouslySetInnerHTML={{__html: preview}} />
      <div className="formula-mode"><button type="button" className={!block ? 'active' : ''} onClick={() => setBlock(false)}>в строке</button><button type="button" className={block ? 'active' : ''} onClick={() => setBlock(true)}>блоком</button></div>
      {edit.existing ? <button type="button" onClick={() => {edit.remove?.(); onClose();}}>Удалить</button> : null}
      <button type="button" onClick={onClose}>Отмена</button>
      <button type="button" className="primary" onClick={() => {edit.apply(tex, block); onClose();}}>Готово</button>
    </div>
    <div className="formula-snippets">{FORMULA_SNIPPETS.map((snippet) => <button type="button" key={snippet.id} title={snippet.code} onClick={() => insertSnippet(snippet.code)}>{snippet.label}</button>)}<span>синтаксис TeX; двойной клик по формуле открывает её здесь</span></div>
  </section>;
}
