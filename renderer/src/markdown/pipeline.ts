import DOMPurify from 'dompurify';
import transform from '@diplodoc/transform';
import {transform as latexTransform} from '@diplodoc/latex-extension';
import {transform as mermaidTransform} from '@diplodoc/mermaid-extension';
import katex from 'katex';
import type {AssetResolver, MarkdownAnalysis, MarkdownHeading, MarkdownLink} from '../types';
import {ALERT_TYPES, PORTABLE_MARKDOWN_POLICY} from './policy';
import {SELF_CONTAINED_KATEX_CSS} from './katexExport';

const ALERTS = new Set<string>(ALERT_TYPES);

const plugins = [
  latexTransform({bundle: false, runtime: 'latex'}),
  mermaidTransform({bundle: false, runtime: 'mermaid'}),
];

function decodeDataContent(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function flattenHeadings(items: Array<{title?: string; href?: string; level?: number; items?: unknown[]}>, result: MarkdownHeading[] = []): MarkdownHeading[] {
  for (const item of items || []) {
    result.push({title: item.title || '', href: item.href || '', level: item.level || 1});
    if (Array.isArray(item.items)) flattenHeadings(item.items as typeof items, result);
  }
  return result;
}

function decorateAlerts(root: ParentNode): void {
  root.querySelectorAll('blockquote').forEach((quote) => {
    const first = quote.firstElementChild;
    if (!first) return;
    const match = first.textContent?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*\n?|\s+)/i);
    if (!match || !ALERTS.has(match[1].toUpperCase())) return;
    const type = match[1].toUpperCase();
    first.innerHTML = first.innerHTML.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:<br\s*\/?>|\s)*/i, '');
    quote.classList.add('fortis-alert', `fortis-alert--${type.toLowerCase()}`);
    quote.setAttribute('data-alert', type);
    quote.setAttribute('aria-label', type);
  });
}

function decorateJira(root: ParentNode, jiraBase: string): void {
  if (!jiraBase) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest('a,code,pre,script,style,.katex,.mermaid')) continue;
    if (/\b[A-Z][A-Z0-9]+-\d+\b/.test(node.data)) nodes.push(node);
  }
  const base = jiraBase.replace(/\/+$/, '');
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of node.data.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)) {
      const index = match.index || 0;
      fragment.append(node.data.slice(last, index));
      const link = document.createElement('a');
      link.className = 'fortis-jira';
      link.dataset.jira = '1';
      link.href = `${base}/browse/${match[1]}`;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = match[1];
      fragment.append(link);
      last = index + match[1].length;
    }
    fragment.append(node.data.slice(last));
    node.replaceWith(fragment);
  }
}

function renderLatex(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.yfm-latex,[data-content][class*="latex"]').forEach((node) => {
    const encoded = node.dataset.content;
    if (!encoded) return;
    const source = decodeDataContent(encoded);
    const options = node.dataset.options || '';
    const displayMode = node.tagName === 'P' || /displayMode[^a-z]*true/i.test(options);
    try {
      node.innerHTML = katex.renderToString(source, {displayMode, throwOnError: false, output: 'htmlAndMathml'});
    } catch {
      node.textContent = source;
    }
  });
}

const TABLE_TAG = /^(TABLE|THEAD|TBODY|TFOOT|TR|TH|TD|COL|COLGROUP)$/u;

function safeTableStyle(value: string): string {
  const result: string[] = [];
  for (const declaration of value.split(';')) {
    const [rawName, ...rawValue] = declaration.split(':');
    const name = rawName?.trim().toLowerCase();
    const property = rawValue.join(':').trim().toLowerCase();
    if (name === 'text-align' && /^(left|center|right)$/u.test(property)) result.push(`${name}:${property}`);
    if (name === 'width' && /^(?:auto|\d+(?:\.\d+)?(?:px|%|em|rem|pt|mm|cm|in)?)$/u.test(property)) result.push(`${name}:${property}`);
  }
  return result.join(';');
}

function prepareHtmlForSanitizing(html: string, rendered: boolean, preserveMermaidStyles = false): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('style').forEach((element) => {
    if (!preserveMermaidStyles || !element.closest('.fortis-mermaid-ready')) element.remove();
  });
  template.content.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/iu.test(attr.name)) element.removeAttribute(attr.name);
    }
    if (element.hasAttribute('style')) {
      const tableStyle = TABLE_TAG.test(element.tagName);
      const generatedRuntime = rendered && Boolean(element.closest('.katex,.fortis-mermaid-ready'));
      if (tableStyle) {
        const clean = safeTableStyle(element.getAttribute('style') || '');
        if (clean) element.setAttribute('style', clean);
        else element.removeAttribute('style');
      } else if (!generatedRuntime || /(?:url\s*\(|expression\s*\(|@import|javascript:)/iu.test(element.getAttribute('style') || '')) {
        element.removeAttribute('style');
      }
    }
    for (const name of ['width', 'align', 'rowspan', 'colspan']) {
      if (!element.hasAttribute(name)) continue;
      const value = element.getAttribute(name) || '';
      if (!TABLE_TAG.test(element.tagName)
        || ((name === 'rowspan' || name === 'colspan') && !/^\d{1,3}$/u.test(value))
        || (name === 'align' && !/^(left|center|right)$/iu.test(value))
        || (name === 'width' && !/^(?:auto|\d+(?:\.\d+)?(?:px|%|em|rem|pt|mm|cm|in)?)$/iu.test(value))) element.removeAttribute(name);
    }
  });
  return template.innerHTML;
}

function purify(html: string, preserveMermaidStyles = false): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: {html: true, svg: true, svgFilters: true, mathMl: true},
    ADD_TAGS: ['foreignObject'],
    ADD_ATTR: [
      'target', 'rel', 'data-alert', 'data-jira', 'data-content', 'data-options',
      'colspan', 'rowspan', 'width', 'align', 'style', 'class', 'aria-label', 'role',
    ],
    FORBID_TAGS: preserveMermaidStyles ? ['script', 'iframe', 'object', 'embed', 'form'] : ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseenter'],
  });
}

export function sanitizeHtml(html: string): string {
  return purify(prepareHtmlForSanitizing(html, false));
}

export function sanitizeRenderedHtml(html: string, preserveMermaidStyles = false): string {
  return purify(prepareHtmlForSanitizing(html, true, preserveMermaidStyles), preserveMermaidStyles);
}

export function renderMarkdown(markdown: string, jiraBase = ''): MarkdownAnalysis {
  const output = transform(markdown, {
    allowHTML: PORTABLE_MARKDOWN_POLICY.allowHtml,
    linkify: PORTABLE_MARKDOWN_POLICY.linkify,
    breaks: PORTABLE_MARKDOWN_POLICY.breaks,
    lang: 'ru',
    needToSanitizeHtml: false,
    enableMarkdownAttrs: false,
    plugins,
  });
  const template = document.createElement('template');
  template.innerHTML = output.result.html;
  decorateAlerts(template.content);
  decorateJira(template.content, jiraBase);
  renderLatex(template.content);
  template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
    if (/^https?:/i.test(link.href)) {
      link.target = '_blank';
      link.rel = 'noreferrer';
    }
  });
  let clean = sanitizeRenderedHtml(template.innerHTML);
  const cleanTemplate = document.createElement('template');
  cleanTemplate.innerHTML = clean;
  let headings = flattenHeadings(output.result.headings || []);
  if (!headings.length) {
    headings = Array.from(cleanTemplate.content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map((heading, index) => {
      if (!heading.id) heading.id = `h-${(heading.textContent || 'section').toLocaleLowerCase('ru').replace(/[^a-zа-яё0-9]+/giu, '-').replace(/^-|-$/g, '') || index + 1}`;
      return {level: Number(heading.tagName.slice(1)), title: heading.textContent || '', href: `#${heading.id}`};
    });
    clean = cleanTemplate.innerHTML;
  }
  const links: MarkdownLink[] = Array.from(cleanTemplate.content.querySelectorAll<HTMLAnchorElement>('a[href]')).map((link) => ({
    label: link.textContent || link.getAttribute('href') || '',
    href: link.getAttribute('href') || '',
    external: /^https?:/i.test(link.getAttribute('href') || ''),
  }));
  const text = cleanTemplate.content.textContent || '';
  return {
    html: clean,
    headings,
    links,
    text,
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
    characters: markdown.length,
    lines: markdown ? markdown.split(/\r?\n/).length : 1,
  };
}

let mermaidConfiguredFor = '';
let mermaidRuntime: Promise<(typeof import('mermaid'))['default']> | null = null;

function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  mermaidRuntime ||= import('mermaid').then((module) => module.default);
  return mermaidRuntime;
}

export async function renderMarkdownWithDiagrams(markdown: string, jiraBase = '', theme: 'light' | 'dark' = 'light'): Promise<MarkdownAnalysis> {
  const analysis = renderMarkdown(markdown, jiraBase);
  const template = document.createElement('template');
  template.innerHTML = analysis.html;
  const nodes = Array.from(template.content.querySelectorAll<HTMLElement>('.mermaid[data-content]'));
  if (nodes.length) {
    const mermaid = await loadMermaid();
    if (mermaidConfiguredFor !== theme) {
      mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default'});
      mermaidConfiguredFor = theme;
    }
    for (const [index, node] of nodes.entries()) {
      const source = decodeDataContent(node.dataset.content || '');
      try {
        await mermaid.parse(source);
        const {svg} = await mermaid.render(`fortis-mermaid-${Date.now()}-${index}`, source);
        node.classList.add('fortis-mermaid-ready');
        node.innerHTML = sanitizeRenderedHtml(svg, true);
      } catch (error) {
        node.classList.add('fortis-mermaid-error');
        node.textContent = `Mermaid: ${error instanceof Error ? error.message : 'ошибка диаграммы'}`;
      }
    }
  }
  return {...analysis, html: sanitizeRenderedHtml(template.innerHTML, true)};
}

function isRelativeResource(source: string): boolean {
  const value = source.trim();
  return Boolean(value) && !value.startsWith('#') && !value.startsWith('/') && !value.startsWith('\\')
    && !/^[a-z][a-z0-9+.-]*:/iu.test(value) && !value.startsWith('//');
}

async function inlineRelativeImages(html: string, resolver?: AssetResolver): Promise<string> {
  if (!resolver) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>('img[src]'));
  await Promise.all(images.map(async (image) => {
    const source = image.getAttribute('src') || '';
    if (!isRelativeResource(source)) return;
    try {
      const resolved = await resolver.resolve(source);
      if (resolved?.startsWith('data:image/')) image.src = resolved;
    } catch {
      // The export remains usable and visibly shows a missing image if a resource disappeared.
    }
  }));
  return sanitizeRenderedHtml(template.innerHTML);
}

export function markdownToPlainText(markdown: string): string {
  return renderMarkdown(markdown).text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export const DOCUMENT_CSS = `
body{margin:0;background:#fff;color:#1c1c1e;font-family:Inter,Arial,sans-serif;font-size:11pt;line-height:1.6}
.doc{max-width:780px;margin:0 auto;padding:24px}h1{font-size:22pt}h2{font-size:16pt}h3{font-size:13pt}
h1,h2,h3,h4,h5,h6{page-break-after:avoid}p{margin:0 0 8pt}a{color:#4a3f8f}
code{font-family:Consolas,monospace;background:#f2f2f5;border-radius:3px;padding:0 3px}
pre{background:#f6f6f8;border:1px solid #e2e2e8;border-radius:5px;padding:10pt;overflow:auto}
pre code{background:none}.fortis-alert{background:#f4f2fb;border-left:3px solid #7a6cc0;padding:8pt 12pt}
table{border-collapse:collapse;width:100%;margin:0 0 12pt}th,td{border:1px solid #d8d8de;padding:5pt 7pt}th{background:#f2f2f5}
blockquote{margin:0 0 10pt;padding-left:12pt;border-left:2px solid #c9c6d8}img,svg{max-width:100%}.mermaid{text-align:center}
`;

export async function buildExportHtml(
  markdown: string,
  title: string,
  options: {pageSize?: string; orientation?: string; marginMm?: number; jiraBase?: string; assetResolver?: AssetResolver} = {},
): Promise<string> {
  const rendered = await renderMarkdownWithDiagrams(markdown, options.jiraBase, 'light');
  const body = await inlineRelativeImages(rendered.html, options.assetResolver);
  const page = `@page{size:${options.pageSize || 'A4'} ${options.orientation || 'portrait'};margin:${options.marginMm ?? 18}mm}`;
  const safeTitle = title.replace(/[<>&"]/g, (char) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'}[char] || char));
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><title>${safeTitle}</title><style>${page}${SELF_CONTAINED_KATEX_CSS}${DOCUMENT_CSS}</style></head><body><main class="doc">${body}</main></body></html>`;
}
