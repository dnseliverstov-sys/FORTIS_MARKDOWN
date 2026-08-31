import type {WorkspaceNode} from '../types';
import type {DocumentTab} from '../types';

const DB_NAME = 'fortis';
const STORE_NAME = 'handles';

let dbPromise: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function putHandle(key: string, handle: FileSystemHandle): Promise<void> {
  try {
    const db = await database();
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(handle, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  } catch {
    // IndexedDB may be unavailable in a browser fallback; the open tab still works.
  }
}

export async function getHandle<T extends FileSystemHandle = FileSystemHandle>(key: string): Promise<T | null> {
  try {
    const db = await database();
    return await new Promise<T | null>((resolve) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as T) || null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function ensureWritePermission(handle: FileSystemHandle): Promise<boolean> {
  const permissions = handle as FileSystemHandle & {
    queryPermission?(options: {mode: 'read' | 'readwrite'}): Promise<PermissionState>;
    requestPermission?(options: {mode: 'read' | 'readwrite'}): Promise<PermissionState>;
  };
  if (!permissions.queryPermission) return true;
  if (await permissions.queryPermission({mode: 'readwrite'}) === 'granted') return true;
  return (await permissions.requestPermission?.({mode: 'readwrite'})) === 'granted';
}

export interface OpenedFile {
  file: File;
  markdown: string;
  bytes: Uint8Array;
}

export function payloadForSave(tab: DocumentTab, untouchedBytes?: Uint8Array): string | Uint8Array {
  return !tab.touched && untouchedBytes ? untouchedBytes : tab.markdown;
}

export async function readHandle(handle: FileSystemFileHandle): Promise<OpenedFile> {
  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {file, bytes, markdown: new TextDecoder('utf-8').decode(bytes)};
}

export async function writeHandle(handle: FileSystemFileHandle, data: string | Uint8Array): Promise<File> {
  if (!(await ensureWritePermission(handle))) throw new Error('Нет разрешения на запись');
  const writable = await handle.createWritable();
  const writableData = typeof data === 'string'
    ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  await writable.write(writableData);
  await writable.close();
  return handle.getFile();
}

export async function pickMarkdownFile(): Promise<{handle: FileSystemFileHandle | null; opened: OpenedFile} | null> {
  if (window.showOpenFilePicker) {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{description: 'Markdown', accept: {'text/markdown': ['.md', '.markdown', '.txt']}}],
    });
    if (!handle) return null;
    return {handle, opened: await readHandle(handle)};
  }
  const file = await inputFile('.md,.markdown,.txt');
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {handle: null, opened: {file, bytes, markdown: new TextDecoder().decode(bytes)}};
}

export async function pickSaveHandle(name: string): Promise<FileSystemFileHandle | null> {
  if (!window.showSaveFilePicker) return null;
  return window.showSaveFilePicker({
    suggestedName: name.replace(/\.(markdown|txt)$/i, '.md'),
    types: [{description: 'Markdown', accept: {'text/markdown': ['.md']}}],
  });
}

export function inputFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function download(name: string, data: string | Uint8Array, mime: string): void {
  if (window.fortisDesktop?.e2e) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    void window.fortisDesktop.saveTestArtifact(name, bytes);
    return;
  }
  const blob = new Blob([data as BlobPart], {type: mime});
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 4000);
}

export async function walkDirectory(directory: FileSystemDirectoryHandle, depth = 0, prefix = ''): Promise<WorkspaceNode[]> {
  if (depth > 8) return [];
  const nodes: WorkspaceNode[] = [];
  const iterable = directory as FileSystemDirectoryHandle & {entries(): AsyncIterableIterator<[string, FileSystemHandle]>};
  for await (const [name, handle] of iterable.entries()) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist') continue;
    const key = `${prefix}/${name}`;
    if (handle.kind === 'directory') {
      nodes.push({type: 'directory', name, key, handle: handle as FileSystemDirectoryHandle, children: await walkDirectory(handle as FileSystemDirectoryHandle, depth + 1, key)});
    } else if (/\.(md|markdown|txt)$/i.test(name)) {
      nodes.push({type: 'file', name, key, handle: handle as FileSystemFileHandle});
    }
  }
  nodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'ru') : a.type === 'directory' ? -1 : 1);
  return nodes;
}

export async function pickWorkspace(): Promise<WorkspaceNode | null> {
  if (window.showDirectoryPicker) {
    const directory = await window.showDirectoryPicker();
    return {type: 'directory', name: directory.name, key: directory.name, handle: directory, children: await walkDirectory(directory, 0, directory.name)};
  }
  return null;
}
