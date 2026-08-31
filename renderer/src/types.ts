export type EditorMode = 'wysiwyg' | 'markup';
export type ViewMode = 'wysiwyg' | 'markup' | 'split';
export type DocumentPanel = 'toc' | 'links' | 'files' | 'versions' | 'jira';

export interface DocumentTab {
  id: string;
  name: string;
  markdown: string;
  savedMarkdown: string;
  dirty: boolean;
  touched: boolean;
  savedAt?: number;
  handleKey?: string;
  revision: number;
}

export interface DocumentRuntime {
  handle?: FileSystemFileHandle;
  originalBytes?: Uint8Array;
  lastModified?: number;
  assetToken?: string;
}

export interface AssetResolver {
  resolve(source: string): Promise<string | null>;
}

export interface RecentFile {
  key: string;
  name: string;
  ts: number;
}

export interface Bookmark {
  key: string;
  name: string;
}

export interface AppSettings {
  theme: string;
  viewMode: ViewMode;
  menuVisible: boolean;
  toolbarVisible: boolean;
  treeVisible: boolean;
  docPanelVisible: boolean;
  docPanel: DocumentPanel;
  spellcheck: boolean;
  jiraBase: string;
  bitbucketBase: string;
  treeWidth: number;
  panelWidth: number;
  shortcuts: Record<string, string>;
  toolbarCommands: string[];
  syncScroll: boolean;
  zoom: number;
}

export interface FortisSession {
  version: 2;
  tabs: DocumentTab[];
  activeId: string | null;
  settings: AppSettings;
  recent: RecentFile[];
  bookmarks: Bookmark[];
}

export interface VersionSnapshot {
  ts: number;
  label: string;
  markdown: string;
}

export interface WorkspaceNode {
  type: 'file' | 'directory';
  name: string;
  key: string;
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
  file?: File;
  children?: WorkspaceNode[];
}

export interface MarkdownHeading {
  level: number;
  title: string;
  href: string;
}

export interface MarkdownLink {
  label: string;
  href: string;
  external: boolean;
}

export interface MarkdownAnalysis {
  html: string;
  headings: MarkdownHeading[];
  links: MarkdownLink[];
  text: string;
  words: number;
  characters: number;
  lines: number;
}

export interface EditorAdapter {
  getMarkdown(): string;
  replaceMarkdown(markdown: string, origin?: 'open' | 'disk' | 'recovery' | 'version'): void;
  setViewMode(mode: ViewMode): void;
  focus(): void;
  insertMarkdown(markdown: string): void;
  getSelectionMarkdown(): string;
  reveal(target: {line?: number; headingId?: string}): void;
  execute(actionId: string, attrs?: Record<string, unknown>): boolean;
}

export interface DesktopApi {
  isDesktop: boolean;
  platform: string;
  e2e: boolean;
  savePdf(html: string, name?: string): Promise<{ok: boolean; canceled?: boolean; fallback?: boolean; path?: string}>;
  registerDocument(file: File): Promise<string | null>;
  readRelativeResource(token: string, source: string): Promise<string | null>;
  setZoomFactor(factor: number): void;
  saveTestArtifact(name: string, data: Uint8Array): Promise<boolean>;
}

declare global {
  interface Window {
    fortisDesktop?: DesktopApi;
    __fortisUnsaved?: () => boolean;
    __fortisSaveAll?: () => Promise<boolean>;
    showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle>;
    showDirectoryPicker?: (options?: Record<string, unknown>) => Promise<FileSystemDirectoryHandle>;
  }

}

export {};
