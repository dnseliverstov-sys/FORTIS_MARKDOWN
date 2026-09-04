import {useState} from 'react';
import type {WorkspaceNode} from '../types';

interface Props {
  root: WorkspaceNode | null;
  onOpen(node: WorkspaceNode): void;
  onClose(): void;
}

function NodeRow({node, depth, onOpen}: {node: WorkspaceNode; depth: number; onOpen(node: WorkspaceNode): void}) {
  const [expanded, setExpanded] = useState(true);
  const directory = node.type === 'directory';
  return (
    <>
      <button
        type="button"
        className="tree-row"
        style={{paddingLeft: `${10 + depth * 14}px`}}
        onClick={() => directory ? setExpanded((value) => !value) : onOpen(node)}
        onDoubleClick={() => !directory && onOpen(node)}
        title={node.key}
      >
        <span className="tree-icon">{directory ? (expanded ? '▾' : '▸') : '·'}</span>
        <span>{directory ? '📁' : '📄'}</span>
        <span className="ellipsis">{node.name}</span>
      </button>
      {directory && expanded ? node.children?.map((child) => <NodeRow key={child.key} node={child} depth={depth + 1} onOpen={onOpen} />) : null}
    </>
  );
}

export function WorkspaceTree({root, onOpen, onClose}: Props) {
  return (
    <aside className="workspace-tree">
      <div className="panel-header"><div className="panel-title">РАБОЧЕЕ ПРОСТРАНСТВО</div><button type="button" className="icon-button" aria-label="Свернуть дерево файлов" title="Свернуть дерево файлов" onClick={onClose}>×</button></div>
      <div className="panel-scroll">{root ? <NodeRow node={root} depth={0} onOpen={onOpen} /> : (
        <div className="empty-panel">Откройте папку с Markdown-файлами.</div>
      )}</div>
    </aside>
  );
}
