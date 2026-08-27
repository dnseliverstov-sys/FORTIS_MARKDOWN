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

const SCHEME = 'fortis';
const ORIGIN = `${SCHEME}://app`;
const RENDERER_DIR = __dirname;

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
    return net.fetch(pathToFileURL(file).toString());
  });
}

/* ---------- экспорт в PDF ---------- */

// Редактор собирает документ для печати в скрытом iframe и зовёт print().
// В браузере это системный диалог печати; здесь мы сразу отдаём PDF.
ipcMain.handle('fortis:save-pdf', async (event, html, suggestedName) => {
  if (typeof html !== 'string' || !html) return { ok: false, fallback: true };
  const parent = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
  // Имя документа редактор кладёт в <title> собираемой страницы.
  const name = suggestedName || (html.match(/<title>([^<]*)<\/title>/i) || [])[1];

  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: 'Сохранить PDF',
    defaultPath: sanitizeName(name) + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

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
  win.on('close', () => {
    clearTimeout(saveTimer);
    writeWindowState(win);
  });

  // Работа с файлами и папками идёт через File System Access API — разрешаем
  // её и буфер обмена, остальное (камера, микрофон, геопозиция) не нужно.
  const allowed = new Set(['fileSystem', 'clipboard-read', 'clipboard-sanitized-write', 'clipboard-write']);
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
  win.webContents.session.setPermissionCheckHandler((wc, permission) => allowed.has(permission));

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

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
