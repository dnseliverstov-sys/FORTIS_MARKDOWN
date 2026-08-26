'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('fortisDesktop', {
  isDesktop: true,
  platform: process.platform,
  savePdf: (html, name) => ipcRenderer.invoke('fortis:save-pdf', html, name)
});

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
