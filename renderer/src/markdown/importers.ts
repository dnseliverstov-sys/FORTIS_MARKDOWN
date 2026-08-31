import JSZip from 'jszip';
import TurndownService from 'turndown';
import {gfm} from 'turndown-plugin-gfm';
import {sanitizeHtml} from './pipeline';
import {PORTABLE_MARKDOWN_POLICY} from './policy';

export interface ImportResult {
  markdown: string;
  losses: string[];
}

export function htmlToMarkdown(html: string): ImportResult {
  const source = new DOMParser().parseFromString(html, 'text/html');
  const losses: string[] = [];
  if (source.querySelector('iframe,video,object,embed,svg')) losses.push('встроенные объекты');
  if (source.querySelector('[style*="color"]')) losses.push('цветовое оформление');
  const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
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
  turndown.addRule('complex-table', {
    filter: (node) => node.nodeName === 'TABLE' && Boolean(
      (node as Element).matches('[width],[style*="width"]')
      || (node as Element).querySelector('[rowspan],[colspan],[width],[style*="width"]'),
    ),
    replacement(_content, node) {
      return `\n\n${sanitizeHtml((node as HTMLElement).outerHTML)}\n\n`;
    },
  });
  return {markdown: turndown.turndown(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n', losses};
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
