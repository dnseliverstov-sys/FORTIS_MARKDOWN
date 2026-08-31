import type {PropsWithChildren, ReactNode} from 'react';

interface Props extends PropsWithChildren {
  title: string;
  onClose(): void;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({title, onClose, footer, wide, children}: Props) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`modal-card${wide ? ' modal-card--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></header>
        <div className="modal-body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </section>
    </div>
  );
}
