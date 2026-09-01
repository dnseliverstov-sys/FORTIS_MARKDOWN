import {describe, expect, it} from 'vitest';
import {renderInlineBreakHtml} from './FortisInlineHtmlExtension';

describe('visual inline HTML', () => {
  it('renders portable br tags as line breaks instead of source text', () => {
    const rendered = renderInlineBreakHtml(' <BR /> ');
    expect(rendered?.matches('span[data-html][data-fortis-inline-break]')).toBe(true);
    expect(rendered?.querySelector('br')).not.toBeNull();
    expect(rendered?.textContent).toBe('');
  });

  it('leaves other inline HTML to the editor HTML node', () => {
    expect(renderInlineBreakHtml('<strong>')).toBeNull();
  });
});
