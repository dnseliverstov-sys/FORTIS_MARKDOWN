import type {ExtensionAuto} from '@gravity-ui/markdown-editor';
import type Token from 'markdown-it/lib/token';
import {ALERT_TYPES, isAlertType, type AlertType} from '../markdown/policy';

export const FORTIS_ALERT_NODE = 'fortis_alert';

function stripAlertMarker(token: Token, type: AlertType): void {
  const marker = new RegExp(`^\\[!${type}\\](?:\\s*\\n|\\s+)?`, 'iu');
  token.content = token.content.replace(marker, '');
  const first = token.children?.find((child) => child.type === 'text');
  if (first) first.content = first.content.replace(marker, '');
}

function transformAlerts(tokens: Token[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index];
    if (open.type !== 'blockquote_open') continue;
    let closeIndex = index + 1;
    let depth = 1;
    for (; closeIndex < tokens.length && depth > 0; closeIndex += 1) {
      if (tokens[closeIndex].type === 'blockquote_open') depth += 1;
      if (tokens[closeIndex].type === 'blockquote_close') depth -= 1;
    }
    const inlineIndex = tokens.findIndex((token, candidate) => candidate > index && candidate < closeIndex && token.type === 'inline');
    if (inlineIndex < 0) continue;
    const inline = tokens[inlineIndex];
    const match = inline.content.match(/^\[!([A-Z]+)\](?:\s*\n|\s+)/iu);
    if (!match || !isAlertType(match[1])) continue;
    const type = match[1].toUpperCase() as AlertType;
    open.type = `${FORTIS_ALERT_NODE}_open`;
    open.tag = 'blockquote';
    open.attrSet('data-alert', type);
    stripAlertMarker(inline, type);

    depth = 1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].type === 'blockquote_open') depth += 1;
      if (tokens[cursor].type === 'blockquote_close') depth -= 1;
      if (depth === 0) {
        tokens[cursor].type = `${FORTIS_ALERT_NODE}_close`;
        break;
      }
    }
  }
}

export const FortisAlertExtension: ExtensionAuto = (builder) => {
  builder.configureMd((md) => {
    md.core.ruler.after('block', 'fortis_alerts', (state) => transformAlerts(state.tokens));
    return md;
  });
  builder
    .addNodeSpec(FORTIS_ALERT_NODE, () => ({
      content: 'block+',
      group: 'block',
      defining: true,
      selectable: true,
      attrs: {type: {default: 'NOTE'}},
      parseDOM: [{
        tag: 'blockquote[data-alert]',
        getAttrs: (dom) => {
          const type = (dom as HTMLElement).dataset.alert?.toUpperCase() || 'NOTE';
          return {type: isAlertType(type) ? type : 'NOTE'};
        },
      }],
      toDOM(node) {
        const type = isAlertType(String(node.attrs.type)) ? String(node.attrs.type) : 'NOTE';
        return ['blockquote', {
          class: `fortis-alert fortis-alert--${type.toLowerCase()}`,
          'data-alert': type,
          'aria-label': type,
        }, 0];
      },
    }))
    .addMarkdownTokenParserSpec(FORTIS_ALERT_NODE, () => ({
      name: FORTIS_ALERT_NODE,
      type: 'block',
      getAttrs: (token) => {
        const type = token.attrGet('data-alert') || 'NOTE';
        return {type: isAlertType(type) ? type.toUpperCase() : 'NOTE'};
      },
    }))
    .addNodeSerializerSpec(FORTIS_ALERT_NODE, () => (state, node) => {
      const type = isAlertType(String(node.attrs.type)) ? String(node.attrs.type).toUpperCase() : ALERT_TYPES[0];
      state.write(`> [!${type}]\n`);
      state.wrapBlock('> ', null, node, () => state.renderContent(node));
    });
};
