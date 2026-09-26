import {useLayoutEffect, useRef} from 'react';
import {createPortal} from 'react-dom';

interface Props {
  x: number;
  y: number;
  label: string;
  items: Array<{label: string; disabled?: boolean; run(): void}>;
  onClose(): void;
}

export function ContextMenu({x, y, label, items, onClose}: Props) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = root.current!;
    const previous = document.activeElement as HTMLElement | null;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: Event) => {if (!menu.contains(event.target as Node)) onClose();};
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      if (previous?.isConnected && menu.contains(document.activeElement)) previous.focus();
    };
  }, [x, y, onClose]);
  return createPortal(<div ref={root} className="fortis-context-menu" role="menu" aria-label={label} style={{left: x, top: y}}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') {event.preventDefault(); onClose();}
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    {items.map((item) => <button type="button" role="menuitem" key={item.label} disabled={item.disabled}
      onClick={() => {onClose(); item.run();}}>{item.label}</button>)}
  </div>, document.body);
}
