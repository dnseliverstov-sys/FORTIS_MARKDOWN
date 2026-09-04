import MarkdownIt from 'markdown-it';
import type {MarkdownHeading, RevealTarget} from '../types';

const parser = new MarkdownIt({html: true});

export function headingLines(markdown: string): number[] {
  const lines: number[] = [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'heading_open' && token.map) lines.push(token.map[0]);
    if (token.type === 'html_block' && token.map) {
      const fragment = new DOMParser().parseFromString(token.content, 'text/html');
      fragment.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(() => lines.push(token.map![0]));
    }
  }
  return lines;
}

export function resolveNavigation(markdown: string, headings: MarkdownHeading[], target: RevealTarget): RevealTarget {
  if (!target.headingId) return target;
  let id = target.headingId;
  try { id = decodeURIComponent(id); } catch { /* literal anchor */ }
  const heading = headings.find((item) => item.href === `#${id}`);
  if (heading) return {...target, headingId: id, line: heading.line, headingIndex: heading.headingIndex};
  for (const token of parser.parse(markdown, {})) {
    if (!token.map || !/<(?:a|h[1-6])\b/iu.test(token.content)) continue;
    const fragment = new DOMParser().parseFromString(token.content, 'text/html');
    const anchor = Array.from(fragment.querySelectorAll('[id],a[name]')).find((node) => node.id === id || node.getAttribute('name') === id);
    if (!anchor) continue;
    const line = token.map[0];
    const next = headings.find((item) => item.line !== undefined && item.line >= line);
    return {...target, headingId: id, line, headingIndex: next?.headingIndex};
  }
  return target;
}
