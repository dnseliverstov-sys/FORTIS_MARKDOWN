export interface FortisTheme {
  id: string;
  name: string;
  gravity: 'light' | 'dark';
  background: string;
  surface: string;
  chrome: string;
  text: string;
  muted: string;
  edge: string;
  accent: string;
  document: string;
  radius: string;
  mono?: boolean;
  serifHeadings?: boolean;
}

export const THEMES: FortisTheme[] = [
  ['nocturne', 'Nocturne', 'dark', '#161826', '#20222d', '#191b25', '#e4e7f5', '#9397ab', '#353846', '#9184d9', '#191b25', '8px'],
  ['carbon', 'Уголь', 'dark', '#0e0f16', '#1a1c26', '#12141c', '#e4e7f5', '#85899b', '#2a2d3a', '#9184d9', '#11131b', '7px'],
  ['indigo', 'Индиго', 'dark', '#1b1f4a', '#262a60', '#202454', '#f0f1ff', '#a7abd0', '#353b80', '#b5abfc', '#202454', '8px'],
  ['taiga', 'Тайга', 'dark', '#0e1a16', '#16241f', '#101d18', '#dcebe4', '#86a294', '#33493e', '#4fc79f', '#101d18', '8px'],
  ['cobalt', 'Кобальт', 'dark', '#0a1524', '#12203a', '#0c1a2e', '#dbe7f8', '#89a2c2', '#2d4a76', '#4ea3ff', '#0d192b', '8px'],
  ['sepia', 'Сепия', 'light', '#f2e9d8', '#fbf5e9', '#ece0c9', '#3a3226', '#756957', '#ddd0b8', '#9a6f31', '#fdf8ee', '8px'],
  ['light', 'Светлая', 'light', '#f3f5fe', '#fafbff', '#e6e9f6', '#292b31', '#666a79', '#cfd3e5', '#796cbf', '#fdfdff', '8px'],
  ['paper', 'Бумага', 'light', '#f7f6f1', '#fdfcf8', '#ebe9e0', '#2d2c28', '#67645a', '#d2cfc5', '#796cbf', '#fffefa', '8px'],
  ['classic', 'Классика', 'light', '#f4f4f6', '#fcfcfd', '#e6e6eb', '#2f3033', '#65676e', '#d3d4d9', '#5d5294', '#fdfdfe', '5px'],
  ['terminal', 'Терминал', 'dark', '#0b0d12', '#151925', '#10131a', '#dfe3ee', '#7d8496', '#2b3143', '#9184d9', '#0e1117', '2px', true],
  ['print', 'Печатная страница', 'light', '#eceae4', '#fdfcf8', '#f7f6f2', '#2a2926', '#67645a', '#c9c4b8', '#796cbf', '#fffdf8', '4px', false, true],
  ['studio', 'Студия', 'dark', '#171a33', '#232852', '#1f2342', '#eceafd', '#9aa0c4', '#3b4181', '#b5abfc', '#1b1f3a', '14px'],
  ['office', 'Офис', 'light', '#f1f1f4', '#fcfcfd', '#e7e7ec', '#2f3033', '#65676e', '#ccccd4', '#5d5294', '#fdfdfe', '4px'],
  ['neon', 'Неон', 'dark', '#07080d', '#12141f', '#0b0c14', '#eceafd', '#9a9ec0', '#3b3f63', '#b5abfc', '#0a0b14', '8px', true],
  ['zen', 'Дзен', 'light', '#faf9f6', '#fffefc', '#faf9f6', '#31302c', '#67645c', '#dedad1', '#7d6fc0', '#fffefc', '12px'],
].map(([id, name, gravity, background, surface, chrome, text, muted, edge, accent, document, radius, mono, serifHeadings]) => ({
  id, name, gravity, background, surface, chrome, text, muted, edge, accent, document, radius, mono, serifHeadings,
}) as FortisTheme);

export function applyTheme(id: string): FortisTheme {
  const theme = THEMES.find((item) => item.id === id) || THEMES[0];
  const root = document.documentElement;
  root.dataset.fortisTheme = theme.id;
  root.dataset.theme = theme.gravity;
  root.style.colorScheme = theme.gravity;
  const values: Record<string, string> = {
    '--fortis-bg': theme.background,
    '--fortis-surface': theme.surface,
    '--fortis-chrome': theme.chrome,
    '--fortis-text': theme.text,
    '--fortis-muted': theme.muted,
    '--fortis-edge': theme.edge,
    '--fortis-accent': theme.accent,
    '--fortis-document': theme.document,
    '--fortis-radius': theme.radius,
    '--fortis-ui-font': theme.mono ? 'ui-monospace, Consolas, monospace' : 'Inter, system-ui, sans-serif',
    '--fortis-heading-font': theme.serifHeadings ? 'Georgia, serif' : 'Inter, system-ui, sans-serif',
  };
  for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value);
  return theme;
}
