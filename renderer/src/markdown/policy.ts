export const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
export type AlertType = typeof ALERT_TYPES[number];

export const PORTABLE_MARKDOWN_POLICY = Object.freeze({
  allowHtml: true,
  linkify: true,
  breaks: false,
  directiveSyntax: 'disabled' as const,
  preserveMarkupFormatting: true,
  preserveEmptyRows: true,
  headingStyle: 'atx' as const,
  bulletListMarker: '-' as const,
  codeBlockStyle: 'fenced' as const,
});

export function isAlertType(value: string): value is AlertType {
  return (ALERT_TYPES as readonly string[]).includes(value.toUpperCase());
}

export function containsNonPortableYfm(markdown: string): boolean {
  return /(?:^|\n)\s*#\|[\s\S]*?\|#\s*(?:\n|$)|\{%\s*\w+/u.test(markdown);
}
