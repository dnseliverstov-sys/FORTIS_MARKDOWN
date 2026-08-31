'use strict';

const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fortisDesktop', {
  isDesktop: true,
  platform: process.platform,
  e2e: Boolean(process.env.FORTIS_E2E_ROOT),
  savePdf: (html, name) => ipcRenderer.invoke('fortis:save-pdf', html, name),
  registerDocument: async (file) => {
    try {
      if (process.env.FORTIS_E2E_ROOT && file) {
        const relative = typeof file.__fortisE2ERelative === 'string' ? file.__fortisE2ERelative : file.name;
        const result = await ipcRenderer.invoke('fortis:e2e-register-document', relative);
        return result && result.token ? result.token : null;
      }
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) return null;
      const result = await ipcRenderer.invoke('fortis:register-document', filePath);
      return result && result.token ? result.token : null;
    } catch {
      return null;
    }
  },
  readRelativeResource: async (token, source) => {
    const result = await ipcRenderer.invoke('fortis:read-relative-resource', token, source);
    return result && result.dataUrl ? result.dataUrl : null;
  },
  setZoomFactor: (factor) => webFrame.setZoomFactor(Math.max(0.5, Math.min(2, Number(factor) || 1))),
  saveTestArtifact: (name, data) => {
    if (!process.env.FORTIS_E2E_ROOT || typeof name !== 'string') return Promise.resolve(false);
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return ipcRenderer.invoke('fortis:e2e-write', name, bytes.toString('base64'));
  }
});

if (process.env.FORTIS_E2E_ROOT) {
  contextBridge.exposeInMainWorld('fortisE2E', {
    list: (relative) => ipcRenderer.invoke('fortis:e2e-list', relative),
    read: (relative) => ipcRenderer.invoke('fortis:e2e-read', relative),
    write: (relative, base64) => ipcRenderer.invoke('fortis:e2e-write', relative, base64),
  });
}

function installE2EFileSystem() {
  const api = window.fortisE2E;
  if (!api) return;
  const join = (parent, name) => [parent, name].filter(Boolean).join('/');
  const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const encode = (bytes) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };
  class TestFileHandle {
    constructor(relative) { this.kind = 'file'; this.relative = relative; this.name = relative.split('/').pop(); }
    async getFile() {
      const value = await api.read(this.relative);
      if (!value) throw new DOMException('File not found', 'NotFoundError');
      const file = new File([decode(value.bytes)], this.name, {lastModified: value.lastModified, type: /\.md$/i.test(this.name) ? 'text/markdown' : ''});
      Object.defineProperty(file, '__fortisE2ERelative', {value: this.relative, enumerable: true});
      return file;
    }
    async createWritable() {
      let bytes = new Uint8Array();
      return {
        write: async (value) => {
          if (typeof value === 'string') bytes = new TextEncoder().encode(value);
          else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
          else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
          else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          else throw new TypeError('Unsupported test write payload');
        },
        close: async () => { if (!(await api.write(this.relative, encode(bytes)))) throw new DOMException('Write failed', 'NotAllowedError'); },
      };
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  class TestDirectoryHandle {
    constructor(relative = '') { this.kind = 'directory'; this.relative = relative; this.name = relative.split('/').pop() || 'FORTIS_E2E_ROOT'; }
    async *entries() {
      for (const entry of await api.list(this.relative)) {
        const relative = join(this.relative, entry.name);
        yield [entry.name, entry.kind === 'directory' ? new TestDirectoryHandle(relative) : new TestFileHandle(relative)];
      }
    }
    async getFileHandle(name) { return new TestFileHandle(join(this.relative, name)); }
    async getDirectoryHandle(name) { return new TestDirectoryHandle(join(this.relative, name)); }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  Object.defineProperty(window, 'showOpenFilePicker', {configurable: true, value: async () => {
    const requested = window.__fortisE2EOpenPath;
    if (requested) return [new TestFileHandle(requested)];
    const first = (await api.list('')).find((entry) => entry.kind === 'file' && /\.(md|markdown|txt)$/i.test(entry.name));
    if (!first) throw new DOMException('No test fixture', 'AbortError');
    return [new TestFileHandle(first.name)];
  }});
  Object.defineProperty(window, 'showSaveFilePicker', {configurable: true, value: async (options) => new TestFileHandle(window.__fortisE2ESavePath || options?.suggestedName || 'saved.md')});
  Object.defineProperty(window, 'showDirectoryPicker', {configurable: true, value: async () => new TestDirectoryHandle()});
}

/**
 * Экспорт в PDF редактор делает так: собирает готовый документ, кладёт его в
 * скрытый iframe через srcdoc и в его onload зовёт contentWindow.print().
 * В браузере это системный диалог печати, где PDF надо выбирать вручную.
 *
 * Здесь подменяем print у этого iframe на прямое сохранение в PDF. Подмена
 * встаёт в обработчик onload раньше того, что поставил редактор: свойство
 * onload редактор присваивает ДО srcdoc, поэтому в сеттере srcdoc мы успеваем
 * обернуть его собственным.
 *
 * Если что-то в цепочке не сработает, вызывается родной print() — то же
 * поведение, что в браузере.
 */
function patchPdfExport() {
  const proto = HTMLIFrameElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
  if (!desc || !desc.set) return;

  Object.defineProperty(proto, 'srcdoc', {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set: function (value) {
      const frame = this;
      const html = String(value);
      const editorOnload = frame.onload;

      frame.onload = function (ev) {
        try {
          const w = frame.contentWindow;
          const nativePrint = w.print ? w.print.bind(w) : null;
          w.print = function () {
            const api = window.fortisDesktop;
            if (!api) { if (nativePrint) nativePrint(); return; }
            api.savePdf(html).then(function (r) {
              if (r && r.fallback && nativePrint) nativePrint();
            }).catch(function () {
              if (nativePrint) nativePrint();
            });
          };
        } catch (e) { /* не свой фрейм — оставляем как есть */ }
        if (typeof editorOnload === 'function') return editorOnload.call(frame, ev);
      };

      desc.set.call(frame, value);
    }
  });
}

webFrame.executeJavaScript('(' + patchPdfExport.toString() + ')()');
if (process.env.FORTIS_E2E_ROOT) webFrame.executeJavaScript('(' + installE2EFileSystem.toString() + ')()');
