import {useEffect, useRef, useState} from 'react';
import type {CommandGroup, CommandRegistry} from '../services/commands';

interface Props {
  registry: CommandRegistry;
  shortcuts: Record<string, string>;
}

const GROUPS: CommandGroup[] = ['Файл', 'Правка', 'Вид', 'Вставка', 'Окно'];

export function CommandMenu({registry, shortcuts}: Props) {
  const [open, setOpen] = useState<CommandGroup | null>(null);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  return <nav className="main-menu" ref={root} aria-label="Главное меню">
    {GROUPS.map((group) => <div className="menu-group" key={group}>
      <button type="button" aria-expanded={open === group} onClick={() => setOpen(open === group ? null : group)}>{group}</button>
      {open === group ? <div className="menu-popup">
        {registry.list(group).map((command) => <button
          type="button"
          key={command.id}
          disabled={!registry.isEnabled(command.id)}
          onClick={() => {setOpen(null); void registry.execute(command.id);}}
        ><span>{command.label}</span><kbd>{shortcuts[command.id] || ''}</kbd></button>)}
      </div> : null}
    </div>)}
  </nav>;
}
