'use strict';

const fs = require('node:fs');

// Ищем графический дисплей ДО подключения Electron: Chromium читает DISPLAY
// при запуске, и позже подставлять уже поздно.
//
// В обычном рабочем столе переменную задаёт сам сеанс. Но если приложение
// запускают оттуда, где она потерялась — по ssh, из systemd-юнита, из урезанного
// терминала, — Chromium не знает, куда рисовать, и падает. В этом случае ищем
// сокет запущенного X-сервера сами: Linux держит их в /tmp/.X11-unix под
// именами X0, X1 и так далее.
//
// Если сокетов нет, X-сервера просто не запущено, и подставлять нечего:
// приложение оконное, без графического сеанса ему не на чем рисовать.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  try {
    const socket = fs.readdirSync('/tmp/.X11-unix')
      .filter((f) => /^X\d+$/.test(f))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0];
    if (socket) process.env.DISPLAY = ':' + socket.slice(1);
  } catch { /* каталога нет — помочь нечем, пусть Electron скажет сам */ }
}

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');

// Аппаратное ускорение отключаем только там, где графической карты нет:
// на виртуальных машинах, в контейнерах и на серверах каталог /dev/dri
// отсутствует, а Chromium всё равно лезет в GPU и падает с «GPU process
// isn't usable». На настоящем рабочем столе ускорение нужно — без него
// прокрутка и ввод заметно медленнее, поэтому отключать его всем подряд
// не стоит.
if (process.platform === 'linux') {
  let hasGpu = false;
  try {
    hasGpu = fs.readdirSync('/dev/dri').some((f) => /^(card|render)/.test(f));
  } catch { hasGpu = false; }
  if (!hasGpu) app.disableHardwareAcceleration();
}
const fsp = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const SCHEME = 'fortis';
const ORIGIN = `${SCHEME}://app`;
const RENDERER_DIR = __dirname;
const documentScopes = new Map();
const registeredScopeOwners = new Set();
const e2eRoot = process.env.FORTIS_E2E_ROOT ? path.resolve(process.env.FORTIS_E2E_ROOT) : null;
if (process.env.FORTIS_E2E_USER_DATA) app.setPath('userData', path.resolve(process.env.FORTIS_E2E_USER_DATA));

function isTrustedRenderer(event) {
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === `${SCHEME}:` && url.hostname === 'app' && !url.username && !url.password;
  } catch { return false; }
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

const resourceMime = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'],
]);
const RENDERER_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'";

function registerDocumentScope(sender, filePath) {
  const token = randomUUID();
  documentScopes.set(token, {owner: sender.id, directory: path.dirname(filePath)});
  if (!registeredScopeOwners.has(sender.id)) {
    const owner = sender.id;
    registeredScopeOwners.add(owner);
    sender.once('destroyed', () => {
      for (const [key, scope] of documentScopes) if (scope.owner === owner) documentScopes.delete(key);
      registeredScopeOwners.delete(owner);
    });
  }
  return token;
}

async function resolveE2EPath(relative = '') {
  if (!e2eRoot || typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('invalid e2e path');
  const root = await fsp.realpath(e2eRoot);
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) throw new Error('e2e path escaped root');
  return {root, target};
}

ipcMain.handle('fortis:register-document', async (event, filePath) => {
  if (!isTrustedRenderer(event) || typeof filePath !== 'string' || !path.isAbsolute(filePath)) return {ok: false};
  try {
    const realFile = await fsp.realpath(filePath);
    if (!(await fsp.stat(realFile)).isFile()) return {ok: false};
    const token = registerDocumentScope(event.sender, realFile);
    return {ok: true, token};
  } catch {
    return {ok: false};
  }
});

ipcMain.handle('fortis:e2e-list', async (event, relative) => {
  if (!e2eRoot || !isTrustedRenderer(event)) return [];
  try {
    const {target} = await resolveE2EPath(relative);
    return (await fsp.readdir(target, {withFileTypes: true})).map((entry) => ({name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file'}));
  } catch { return []; }
});

ipcMain.handle('fortis:e2e-read', async (event, relative) => {
  if (!e2eRoot || !isTrustedRenderer(event)) return null;
  try {
    const {target} = await resolveE2EPath(relative);
    const realTarget = await fsp.realpath(target);
    const {root} = await resolveE2EPath();
    if (!isInside(root, realTarget)) return null;
    const stat = await fsp.stat(realTarget);
    if (!stat.isFile()) return null;
    return {bytes: (await fsp.readFile(realTarget)).toString('base64'), lastModified: stat.mtimeMs};
  } catch { return null; }
});

ipcMain.handle('fortis:e2e-write', async (event, relative, base64) => {
  if (!e2eRoot || !isTrustedRenderer(event) || typeof base64 !== 'string') return false;
  try {
    const {target} = await resolveE2EPath(relative);
    await fsp.mkdir(path.dirname(target), {recursive: true});
    await fsp.writeFile(target, Buffer.from(base64, 'base64'));
    return true;
  } catch { return false; }
});

ipcMain.handle('fortis:e2e-register-document', async (event, relative) => {
  if (!e2eRoot || !isTrustedRenderer(event)) return {ok: false};
  try {
    const {root, target} = await resolveE2EPath(relative);
    const realTarget = await fsp.realpath(target);
    if (!isInside(root, realTarget) || !(await fsp.stat(realTarget)).isFile()) return {ok: false};
    return {ok: true, token: registerDocumentScope(event.sender, realTarget)};
  } catch { return {ok: false}; }
});

ipcMain.handle('fortis:read-relative-resource', async (event, token, source) => {
  if (!isTrustedRenderer(event) || typeof token !== 'string' || typeof source !== 'string') return {ok: false};
  const scope = documentScopes.get(token);
  if (!scope || scope.owner !== event.sender.id || !source || source.includes('\0')) return {ok: false};
  const clean = source.split(/[?#]/u, 1)[0];
  if (!clean || path.isAbsolute(clean) || /^[a-z][a-z0-9+.-]*:/iu.test(clean)) return {ok: false};
  try {
    const candidate = await fsp.realpath(path.resolve(scope.directory, decodeURIComponent(clean)));
    if (!isInside(scope.directory, candidate)) return {ok: false};
    const extension = path.extname(candidate).toLowerCase();
    const mime = resourceMime.get(extension);
    if (!mime) return {ok: false};
    const stat = await fsp.stat(candidate);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return {ok: false};
    let bytes = await fsp.readFile(candidate);
    if (mime === 'image/svg+xml') {
      const svg = bytes.toString('utf8')
        .replace(/<script\b[\s\S]*?<\/script\s*>/giu, '')
        .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '')
        .replace(/(?:javascript:|data:text\/html)/giu, '');
      bytes = Buffer.from(svg, 'utf8');
    }
    return {ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`};
  } catch {
    return {ok: false};
  }
});

// Своя схема вместо file:// — она объявлена standard + secure, поэтому
// localStorage, IndexedDB и File System Access API работают так же,
// как на настоящем сайте по https.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
  }
]);

/* ---------- состояние окна ---------- */

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch { /* первый запуск или битый файл — берём умолчания */ }
  return { width: 1440, height: 900 };
}

function writeWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
  const s = { ...b, maximized: win.isMaximized() };
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch { /* не смогли запомнить размер — не повод падать */ }
}

/* ---------- отдача файлов приложения ---------- */

function serveRenderer() {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(RENDERER_DIR, rel);
    // Наружу из каталога приложения не выпускаем.
    if (!file.startsWith(RENDERER_DIR + path.sep) && file !== RENDERER_DIR) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      await fsp.access(file);
    } catch {
      return new Response('not found', { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!/\.html?$/i.test(rel)) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', RENDERER_CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  });
}

/* ---------- экспорт в PDF ---------- */

// Редактор собирает документ для печати в скрытом iframe и зовёт print().
// В браузере это системный диалог печати; здесь мы сразу отдаём PDF.
ipcMain.handle('fortis:save-pdf', async (event, html, suggestedName) => {
  if (!isTrustedRenderer(event) || typeof html !== 'string' || !html || html.length > 50 * 1024 * 1024) return { ok: false, fallback: true };
  const parent = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
  // Имя документа редактор кладёт в <title> собираемой страницы.
  const name = suggestedName || (html.match(/<title>([^<]*)<\/title>/i) || [])[1];

  let filePath;
  if (e2eRoot) {
    filePath = path.join(e2eRoot, sanitizeName(name) + '.pdf');
  } else {
    const selected = await dialog.showSaveDialog(parent, {
      title: 'Сохранить PDF',
      defaultPath: sanitizeName(name) + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (selected.canceled || !selected.filePath) return { ok: false, canceled: true };
    filePath = selected.filePath;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fortis-pdf-'));
  const tmpHtml = path.join(tmpDir, 'doc.html');
  await fsp.writeFile(tmpHtml, html, 'utf8');

  const printer = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true }
  });
  try {
    await printer.loadURL(pathToFileURL(tmpHtml).toString());
    // Даём шрифтам и KaTeX-стилям встать до снимка страницы.
    await new Promise((r) => setTimeout(r, 400));
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true // размер и поля берём из @page, который поставил редактор
    });
    await fsp.writeFile(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (e) {
    dialog.showErrorBox('Не удалось сохранить PDF', String(e && e.message ? e.message : e));
    return { ok: false, error: String(e) };
  } finally {
    printer.destroy();
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

function sanitizeName(name) {
  const base = String(name || 'документ').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  return base || 'документ';
}

/* ---------- меню ---------- */

// Своих ускорителей у меню почти нет: редактор занял почти весь ряд Ctrl/Cmd
// (N, O, S, W, F, R, D, E, B, J), и пункт меню перехватил бы их у него.
// Оставляем только то, что нужно системе: правку (иначе на macOS не работают
// Cmd+C/V), масштаб и окно.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  if (!isMac) {
    Menu.setApplicationMenu(null); // на Windows и Linux копирование работает и без меню
    return;
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'pasteAndMatchStyle', label: 'Вставить как текст' },
        { role: 'selectAll', label: 'Выделить всё' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Крупнее' },
        { role: 'zoomOut', label: 'Мельче' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { type: 'separator' },
        { label: 'Перезагрузить окно', accelerator: 'Alt+Command+R', click: (_i, win) => win && win.reload() },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' }
      ]
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'zoom', label: 'Увеличить' },
        { role: 'front', label: 'Все окна вперёд' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- закрытие окна ---------- */

// Страница держит закрытие, пока есть несохранённые изменения. В браузере на
// это показывают вопрос «уйти со страницы?», а Electron такой запрос молча
// отменяет: красная кнопка просто перестаёт отвечать, и никто не понимает,
// почему. Поэтому вопрос задаём сами.

async function ask(win, code) {
  try {
    // userGesture: без него редактор не сможет открыть окно выбора файла.
    return await win.webContents.executeJavaScript(code, true);
  } catch {
    return null;
  }
}

const UNSAVED = `(() => {
  if (typeof window.__fortisUnsaved === 'function') return window.__fortisUnsaved();
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
})()`;

async function confirmClose(win, close) {
  writeWindowState(win);
  const finish = async (discard = false) => {
    const ready = await ask(win, `window.__fortisPrepareClose ? window.__fortisPrepareClose(${discard}) : false`);
    if (ready === true && !win.isDestroyed()) close();
  };
  if (!(await ask(win, UNSAVED))) { await finish(); return; }

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    message: 'Есть несохранённые изменения',
    detail: 'Сохранить их перед закрытием?'
  });
  if (response === 2) return;              // отмена — окно остаётся открытым
  if (response === 1) { await finish(true); return; }

  const stillDirty = await ask(win, 'window.__fortisSaveAll ? window.__fortisSaveAll() : true');
  if (win.isDestroyed()) return;
  if (stillDirty) {
    // Сохранение не довели до конца — окно оставляем открытым, иначе текст
    // пропадёт. Пользователь сохранит вручную и закроет ещё раз.
    return;
  }
  await finish();
}

/* ---------- окно ---------- */

function createWindow() {
  const s = readWindowState();
  const win = new BrowserWindow({
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#161826',
    title: 'FORTIS Markdown Editor',
    icon: process.platform === 'linux' ? path.join(__dirname, '..', 'build', 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload'у нужны require и webFrame
      spellcheck: true,
      devTools: true
    }
  });

  if (s.maximized) win.maximize();

  // Заголовок окна наш, а не <title> из собранной страницы («Bundled Page»).
  win.on('page-title-updated', (e) => e.preventDefault());

  win.once('ready-to-show', () => win.show());

  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeWindowState(win), 400);
  };
  win.on('resize', remember);
  win.on('move', remember);
  let closing = false;
  win.on('close', (e) => {
    clearTimeout(saveTimer);
    if (closing) return;
    e.preventDefault();
    confirmClose(win, () => { closing = true; win.destroy(); });
  });

  // Работа с файлами и папками идёт через File System Access API — разрешаем
  // её и буфер обмена, остальное (камера, микрофон, геопозиция) не нужно.
  const allowed = new Set(['fileSystem', 'clipboard-read', 'clipboard-sanitized-write', 'clipboard-write']);
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
  win.webContents.session.setPermissionCheckHandler((wc, permission) => allowed.has(permission));

  // Native editing commands preserve the editor selection and rich clipboard data.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    Menu.buildFromTemplate([
      {label: 'Скопировать', role: 'copy', enabled: params.editFlags.canCopy},
      {label: 'Вырезать', role: 'cut', enabled: params.isEditable && params.editFlags.canCut},
      {label: 'Вставить', role: 'paste', enabled: params.isEditable && params.editFlags.canPaste},
    ]).popup({window: win, frame: params.frame});
  });

  // Внешние ссылки открываем в браузере, а не новым окном Electron.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

/* ---------- запуск ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    serveRenderer();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Закрыли окно — закрыли приложение. На macOS принято оставлять программу
  // в доке без окон, но редактор однооконный, и вернуть окно оттуда нечем,
  // кроме значка в доке: «нажал закрыть, а оно висит» читается как поломка.
  app.on('window-all-closed', () => app.quit());
}
