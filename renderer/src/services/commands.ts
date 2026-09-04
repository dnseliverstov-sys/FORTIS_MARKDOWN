export type CommandGroup = 'Файл' | 'Правка' | 'Вид' | 'Вставка' | 'Окно';

export interface FortisCommand {
  id: string;
  label: string;
  group: CommandGroup;
  run(): void | Promise<void>;
  enabled?: () => boolean;
  allowInsideEditor?: boolean;
}

export class CommandRegistry {
  private commands = new Map<string, FortisCommand>();

  replace(commands: FortisCommand[]): void {
    this.commands = new Map(commands.map((command) => [command.id, command]));
  }

  get(id: string): FortisCommand | undefined {
    return this.commands.get(id);
  }

  list(group?: CommandGroup): FortisCommand[] {
    return Array.from(this.commands.values()).filter((command) => !group || command.group === group);
  }

  isEnabled(id: string): boolean {
    const command = this.get(id);
    return Boolean(command && (command.enabled?.() ?? true));
  }

  async execute(id: string): Promise<boolean> {
    const command = this.get(id);
    if (!command || !(command.enabled?.() ?? true)) return false;
    await command.run();
    return true;
  }
}

export function normalizeKeyboardCombo(value: string): string {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  const modifiers = [
    parts.some((part) => /^(ctrl|control|meta|cmd|command)$/i.test(part)) ? 'Ctrl' : '',
    parts.some((part) => /^alt$/i.test(part)) ? 'Alt' : '',
    parts.some((part) => /^shift$/i.test(part)) ? 'Shift' : '',
  ].filter(Boolean);
  const key = parts.find((part) => !/^(ctrl|control|meta|cmd|command|alt|shift)$/i.test(part));
  if (key) modifiers.push(key.length === 1 ? key.toUpperCase() : key);
  return modifiers.join('+');
}

export function keyboardCombo(event: KeyboardEvent): string {
  const keys: string[] = [];
  if (event.ctrlKey || event.metaKey) keys.push('Ctrl');
  if (event.altKey) keys.push('Alt');
  if (event.shiftKey) keys.push('Shift');
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
    const key = (event.ctrlKey || event.metaKey || event.altKey) && /^Key[A-Z]$/u.test(event.code)
      ? event.code.slice(3) : event.key;
    keys.push(key.length === 1 ? key.toUpperCase() : key);
  }
  return keys.join('+');
}

export function isEditorTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input,textarea,[contenteditable="true"],.cm-editor,.ProseMirror'));
}

export function shortcutConflicts(shortcuts: Record<string, string>): Map<string, string[]> {
  const byCombo = new Map<string, string[]>();
  for (const [id, raw] of Object.entries(shortcuts)) {
    const combo = normalizeKeyboardCombo(raw);
    if (!combo) continue;
    byCombo.set(combo, [...(byCombo.get(combo) || []), id]);
  }
  return new Map(Array.from(byCombo).filter(([, ids]) => ids.length > 1));
}

export function installCommandShortcuts(
  registry: CommandRegistry,
  shortcuts: () => Record<string, string>,
  signal: AbortSignal,
): void {
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key === 'Escape') return;
    const combo = keyboardCombo(event);
    const entry = Object.entries(shortcuts()).find(([, shortcut]) => normalizeKeyboardCombo(shortcut) === combo);
    if (!entry) return;
    const command = registry.get(entry[0]);
    if (!command || !(command.enabled?.() ?? true)) return;
    if (isEditorTarget(event.target) && !command.allowInsideEditor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void registry.execute(command.id);
  }, {signal, capture: true});
}
