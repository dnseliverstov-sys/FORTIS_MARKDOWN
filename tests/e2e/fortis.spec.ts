import {test, expect, _electron as electron, type ElectronApplication, type Page} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test.describe.configure({mode: 'serial'});

let app: ElectronApplication;
let page: Page;
let root: string;
let userData: string;
const runtimeErrors: string[] = [];
const externalResources: string[] = [];

function watchPage(target: Page): void {
  target.on('pageerror', (error) => runtimeErrors.push(error.message));
  target.on('request', (request) => {if (/^https?:/iu.test(request.url())) externalResources.push(request.url());});
}

async function launchFortis(): Promise<void> {
  app = await electron.launch({
    args: [path.resolve('app/main.js')],
    cwd: path.resolve('.'),
    env: {...process.env, FORTIS_E2E_ROOT: root, FORTIS_E2E_USER_DATA: userData},
  });
  page = await app.firstWindow();
  watchPage(page);
  await expect(page.locator('.brand')).toContainText('FORTIS');
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fortis-e2e-root-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fortis-e2e-user-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.copyFileSync(path.resolve('tests/golden/portable.md'), path.join(root, 'portable.md'));
  fs.copyFileSync(path.resolve('tests/golden/complex-table.md'), path.join(root, 'complex-table.md'));
  fs.writeFileSync(path.join(root, 'assets/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  await launchFortis();
});

test.afterAll(async () => {
  if (app) {
    await Promise.race([
      app.evaluate(({app: electronApp}) => electronApp.exit(0)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (!app.process().killed) app.process().kill();
  }
  for (const directory of [root, userData]) {
    try {fs.rmSync(directory, {recursive: true, force: true});} catch { /* Windows may release Chromium files just after process exit. */ }
  }
});

test('@smoke desktop shell and Gravity editor satisfy the CDP contract', async () => {
  const contract = await page.evaluate(() => ({
    url: location.href,
    origin: location.origin,
    secure: isSecureContext,
    directoryPicker: typeof window.showDirectoryPicker,
    desktop: Boolean(window.fortisDesktop),
    katex: typeof (window as unknown as {katex?: unknown}).katex,
    text: document.body.innerText,
    proseMirror: document.querySelectorAll('.ProseMirror').length,
    appHeight: document.querySelector('.fortis-app')?.getBoundingClientRect().height || 0,
    statusBottom: document.querySelector('.statusbar')?.getBoundingClientRect().bottom || 0,
    viewportHeight: innerHeight,
    external: performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => /^https?:/iu.test(url)),
  }));
  expect(contract.url).toBe('fortis://app/index.html');
  expect(contract.origin).toBe('fortis://app');
  expect(contract.secure).toBe(true);
  expect(contract.directoryPicker).toBe('function');
  expect(contract.desktop).toBe(true);
  expect(contract.katex).toBe('object');
  expect(contract.text.startsWith('FORTIS')).toBe(true);
  expect(contract.proseMirror).toBeGreaterThan(0);
  expect(contract.appHeight).toBe(contract.viewportHeight);
  expect(contract.statusBottom).toBe(contract.viewportHeight);
  expect(contract.external).toEqual([]);
});

test('restores autosaved Markdown after an interrupted desktop session', async () => {
  await page.evaluate(() => {
    localStorage.setItem('fortis.exit', 'no');
    localStorage.setItem('fortis.autosave', JSON.stringify({
      ts: Date.now(),
      tabs: [{name: 'Восстановленный.md', md: '# Черновик после сбоя\n'}],
    }));
    // Registered after the application handler, this restores the crash marker
    // after pagehide has attempted to mark an ordinary clean navigation.
    window.addEventListener('pagehide', () => localStorage.setItem('fortis.exit', 'no'), {once: true});
  });
  const loaded = page.waitForEvent('load');
  await page.evaluate(() => location.reload());
  await loaded;
  await expect(page.locator('.brand')).toContainText('FORTIS');

  await expect(page.getByRole('dialog', {name: 'Восстановить черновики?'})).toBeVisible();
  await page.getByRole('button', {name: 'Восстановить', exact: true}).click();
  await expect(page.locator('.file-tab.active')).toContainText('Восстановленный.md');
  await expect(page.locator('.document-panel')).toContainText('Черновик после сбоя');
  await page.getByRole('button', {name: 'Закрыть Восстановленный.md', exact: true}).click();
  await page.getByRole('button', {name: 'Не сохранять', exact: true}).click();
  await page.evaluate(() => localStorage.removeItem('fortis.autosave'));
  expect(runtimeErrors).toEqual([]);
  expect(externalResources).toEqual([]);
});

test('opens and saves exact bytes, then preserves exact Markdown edits', async () => {
  const fixture = path.join(root, 'portable.md');
  const original = fs.readFileSync(fixture);
  await page.evaluate(() => {(window as unknown as {__fortisE2EOpenPath: string}).__fortisE2EOpenPath = 'portable.md';});
  await page.locator('.actionbar button[title^="Открыть файл"]').click();
  await expect(page.locator('.file-tab.active')).toContainText('portable.md');
  await page.locator('.actionbar button[title^="Сохранить"]').click();
  await expect.poll(() => fs.readFileSync(fixture).equals(original)).toBe(true);

  await page.getByRole('button', {name: 'Разметка', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .cm-editor')).toBeVisible();
  await page.locator('.editor-pane:not([hidden]) .cm-content').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText('\n\nТочный хвост  \n');
  await page.locator('.actionbar button[title^="Сохранить"]').click();
  await expect.poll(() => fs.readFileSync(fixture, 'utf8').endsWith('\n\nТочный хвост  \n')).toBe(true);
  await page.getByRole('button', {name: 'Визуально', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror .fortis-alert[data-alert="NOTE"]')).toBeVisible();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror a.fortis-jira')).toContainText('DOCS-42');
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror .math-container').first()).toBeVisible();
  await expect(page.locator('.file-tab.active')).not.toContainText('●');
  await page.getByRole('button', {name: 'Разметка', exact: true}).click();
  await expect(page.locator('.file-tab.active')).not.toContainText('●');
});

test('keeps tab state, renders Mermaid and exports autonomous HTML/TXT/PDF', async () => {
  await page.locator('.actionbar button[title^="Новый документ"]').click();
  await expect(page.locator('.file-tab.active')).toContainText('Без имени.md');
  await page.locator('.editor-pane:not([hidden]) .cm-content').focus();
  await page.keyboard.insertText('# Вторая вкладка\n');
  await page.locator('.file-tab', {hasText: 'portable.md'}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .cm-content')).toContainText('Проверка FORTIS');
  await page.getByRole('button', {name: 'Рядом', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .fortis-preview svg')).toBeVisible({timeout: 30_000});

  await page.locator('.actionbar button[title^="Экспорт"]').click();
  await page.getByRole('button', {name: 'Экспортировать'}).click();
  const htmlPath = path.join(root, 'portable.html');
  await expect.poll(() => fs.existsSync(htmlPath) && fs.statSync(htmlPath).size > 100_000).toBe(true);
  const html = fs.readFileSync(htmlPath, 'utf8');
  expect(html).toContain('data:font/woff2;base64,');
  expect(html).toContain('data:image/png;base64,');
  expect(html).toContain('<svg');
  // Ordinary hyperlinks may stay external; a self-contained export must not
  // fetch scripts, stylesheets or embedded media over the network.
  expect(html).not.toMatch(/<(?:img|script|link)\b[^>]*(?:src|href)=["']https?:/iu);
  expect(html).not.toMatch(/url\(["']?https?:/iu);

  await page.locator('.actionbar button[title^="Экспорт"]').click();
  await page.locator('input[type="radio"][value="txt"]').check();
  await page.getByRole('button', {name: 'Экспортировать'}).click();
  const txtPath = path.join(root, 'portable.txt');
  await expect.poll(() => fs.existsSync(txtPath)).toBe(true);
  expect(fs.readFileSync(txtPath, 'utf8')).toContain('Проверка FORTIS');

  await page.locator('.actionbar button[title^="Экспорт"]').click();
  await page.locator('input[type="radio"][value="pdf"]').check();
  await page.getByRole('button', {name: 'Экспортировать'}).click();
  const pdf = path.join(root, 'portable.pdf');
  await expect.poll(() => fs.existsSync(pdf) && fs.statSync(pdf).size > 1_000, {timeout: 30_000}).toBe(true);
  expect(runtimeErrors).toEqual([]);
  expect(externalResources).toEqual([]);
});

test('keeps mode changes clean and covers complex tables, formulas, isolated undo, workspace and conflicts', async () => {
  await page.evaluate(() => {(window as unknown as {__fortisE2EOpenPath: string}).__fortisE2EOpenPath = 'complex-table.md';});
  await page.locator('.actionbar button[title^="Открыть файл"]').click();
  await expect(page.locator('.file-tab.active')).toContainText('complex-table.md');
  await expect(page.locator('.file-tab.active')).not.toContainText('●');

  await page.getByRole('button', {name: 'Визуально', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror table')).toBeVisible();
  await expect(page.locator('.file-tab.active')).not.toContainText('●');
  await page.getByRole('button', {name: 'Разметка', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .cm-content')).toContainText('rowspan="2"');
  await expect(page.locator('.file-tab.active')).not.toContainText('●');

  await page.locator('.actionbar button[title^="Таблица"]').click();
  await page.getByRole('button', {name: '+ строка', exact: true}).click();
  await page.getByRole('button', {name: 'Применить', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .cm-content')).toContainText('<strong>A</strong>');
  await expect(page.locator('.editor-pane:not([hidden]) .cm-content')).toContainText('<em>C</em>');

  await page.locator('.actionbar button[title^="Новый документ"]').click();
  await page.locator('.actionbar button[title^="Формула"]').click();
  await page.locator('.formula-input').fill('\\frac{a}{b}');
  await page.getByRole('button', {name: 'блоком', exact: true}).click();
  await page.getByRole('button', {name: 'Готово', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .cm-content')).toContainText('\\frac{a}{b}');
  await page.getByRole('button', {name: 'Визуально', exact: true}).click();
  const formula = page.locator('.editor-pane:not([hidden]) .math-container').first();
  await expect(formula).toBeVisible();
  await formula.dblclick();
  await expect(page.locator('.formula-input')).toHaveValue('\\frac{a}{b}');
  await page.getByRole('button', {name: 'Удалить', exact: true}).click();
  await expect(formula).toHaveCount(0);
  await page.locator('.actionbar button[title^="Формула"]').click();
  await page.locator('.formula-input').fill('\\frac{a}{b}');
  await page.getByRole('button', {name: 'блоком', exact: true}).click();
  await page.getByRole('button', {name: 'Готово', exact: true}).click();
  await page.getByRole('button', {name: 'Разметка', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .cm-content')).toContainText('\\frac{a}{b}');
  const formulaTabIndex = await page.locator('.file-tab').count() - 1;

  await page.locator('.actionbar button[title^="Новый документ"]').click();
  const secondEditor = page.locator('.editor-pane:not([hidden]) .cm-content');
  await secondEditor.focus();
  await page.keyboard.insertText('SECOND-TAB');
  await page.locator('.actionbar button[title^="Отменить"]').click();
  await expect(secondEditor).not.toContainText('SECOND-TAB');
  await page.locator('.file-tab').nth(formulaTabIndex).click();
  await expect(page.locator('.editor-pane:not([hidden]) .cm-content')).toContainText('\\frac{a}{b}');

  await page.locator('.brand').click();
  await page.keyboard.press('Control+Shift+P');
  await page.getByRole('button', {name: /Бумага/u}).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fortisTheme)).toBe('paper');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', {name: 'Оформление'})).toBeHidden();

  await page.getByRole('button', {name: 'Вид', exact: true}).click();
  await page.locator('.menu-popup').getByRole('button', {name: /Горячие клавиши/u}).click();
  const firstShortcut = page.locator('.shortcut-grid input').first();
  await firstShortcut.focus();
  await page.keyboard.press('Control+O');
  await expect(page.getByRole('dialog', {name: 'Горячие клавиши'}).locator('.warning-box')).toContainText('Ctrl+O');
  await page.getByRole('button', {name: 'Сбросить', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Горячие клавиши'}).locator('.warning-box')).toHaveCount(0);
  await page.getByRole('button', {name: 'Готово', exact: true}).click();

  await page.locator('.actionbar button[title^="Открыть папку"]').click();
  await expect(page.locator('.workspace-tree')).toContainText('portable.md');
  await page.locator('.brand').click();
  await page.keyboard.press('Control+Shift+F');
  await page.getByPlaceholder('Найти').fill('Проверка FORTIS');
  await page.getByRole('button', {name: 'В папке', exact: true}).click();
  await expect(page.locator('.workspace-hits')).toContainText('portable.md:1');

  await page.locator('.file-tab', {hasText: 'portable.md'}).click();
  const fixture = path.join(root, 'portable.md');
  fs.writeFileSync(fixture, '# Внешняя версия\n\nИзменено другой программой.\n', 'utf8');
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(fixture, future, future);
  await expect(page.getByRole('dialog', {name: 'Файл изменён на диске'})).toBeVisible({timeout: 15_000});
  await page.getByRole('button', {name: 'Взять с диска', exact: true}).click();
  await expect(page.locator('.document-panel')).toContainText('Внешняя версия');

  expect(runtimeErrors).toEqual([]);
  expect(externalResources).toEqual([]);
});
