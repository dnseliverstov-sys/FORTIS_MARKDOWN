import {test, expect, _electron as electron, type ElectronApplication, type Page} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';

let app: ElectronApplication;
let electronProcess: ChildProcess;
let page: Page;
let root: string;
let userData: string;
let errors: string[];
type MenuTestGlobal = typeof globalThis & {__fortisTestMenu?: import('electron').Menu};

async function launch() {
  app = await electron.launch({args: [path.resolve('app/main.js')], env: {...globalThis.process.env, FORTIS_E2E_ROOT: root, FORTIS_E2E_USER_DATA: userData}});
  electronProcess = app.process();
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  await expect(page.locator('.brand')).toContainText('FORTIS');
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror')).toBeVisible();
}

async function crash() {
  await app.evaluate(({app: electronApp}) => electronApp.exit(0));
  await expect.poll(() => electronProcess.exitCode).not.toBeNull();
}

async function closeNormally(response?: number) {
  if (response !== undefined) await app.evaluate(({dialog}, choice) => {dialog.showMessageBox = async () => ({response: choice, checkboxChecked: false});}, response);
  await app.evaluate(({BrowserWindow}) => {BrowserWindow.getAllWindows()[0].close();});
  await expect.poll(() => electronProcess.exitCode).not.toBeNull();
}

async function openFile(name: string, markdown: string) {
  fs.writeFileSync(path.join(root, name), markdown);
  await page.evaluate((file) => {(window as unknown as {__fortisE2EOpenPath: string}).__fortisE2EOpenPath = file;}, name);
  await page.locator('.actionbar').getByRole('button', {name: 'Открыть файл', exact: true}).click();
  await expect(page.locator('.file-tab.active')).toContainText(name);
}

async function storedTabs() {
  return page.evaluate(() => JSON.parse(localStorage.getItem('fortis.session') || '{"tabs":[]}').tabs as Array<{id: string; name: string; dirty: boolean; markdown: string}>);
}

test.beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fortis-feedback-files-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fortis-feedback-user-'));
  errors = [];
  await launch();
});

test.afterEach(async () => {
  if (electronProcess?.exitCode === null) await crash();
  for (const directory of [root, userData]) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('fortis-feedback-')) throw new Error('Unexpected test directory');
    fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
  expect(errors).toEqual([]);
});

test('read-only opening and mode changes preserve bytes across two clean restarts', async () => {
  const markdown = '# Файл\r\n\r\n| A  | B  |\r\n|----|----|\r\n| 1  | 2  |\r\n\r\n```mermaid\r\nflowchart LR\r\n A --> B\r\n```\r\n';
  await openFile('unchanged.md', markdown);
  for (const mode of ['Разметка', 'Рядом', 'Визуально']) await page.getByRole('button', {name: mode, exact: true}).click();
  await expect.poll(async () => (await storedTabs()).find((tab) => tab.name === 'unchanged.md')?.markdown).toBe(markdown);
  await page.waitForTimeout(3000); // Includes Mermaid initialization and an autosave tick.
  expect((await storedTabs()).every((tab) => !tab.dirty)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('fortis.autosave'))).toBeNull();
  for (let index = 0; index < 2; index++) {
    await closeNormally();
    await launch();
    await expect(page.getByRole('dialog', {name: 'Восстановить черновики?'})).toBeHidden();
    await expect(page.locator('.file-tab.active')).toContainText('unchanged.md');
  }
  await page.locator('.actionbar').getByRole('button', {name: 'Сохранить', exact: true}).click();
  expect(fs.readFileSync(path.join(root, 'unchanged.md'), 'utf8')).toBe(markdown);
});

test('declining real crash recovery rolls back a saved document and stays declined', async () => {
  await openFile('saved.md', '# Сохранено\n');
  await page.locator('.editor-pane:not([hidden]) .ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' черновик');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fortis.autosave') || 'null')?.tabs?.some((tab: {md: string}) => tab.md.includes('черновик')))).toBe(true);
  await crash();
  await launch();
  const dialog = page.getByRole('dialog', {name: 'Восстановить черновики?'});
  await expect(dialog).toBeVisible();
  const backup = await page.evaluate(() => localStorage.getItem('fortis.autosave'));
  await page.waitForTimeout(2800);
  expect(await page.evaluate(() => localStorage.getItem('fortis.autosave'))).toBe(backup);
  await dialog.getByRole('button', {name: 'Не восстанавливать'}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror')).not.toContainText('черновик');
  await page.waitForTimeout(2800);
  expect(await page.evaluate(() => localStorage.getItem('fortis.autosave'))).toBeNull();
  for (let index = 0; index < 2; index++) {
    await closeNormally();
    await launch();
    await expect(page.getByRole('dialog', {name: 'Восстановить черновики?'})).toBeHidden();
    expect((await storedTabs()).every((tab) => !tab.dirty)).toBe(true);
  }
  expect(fs.readFileSync(path.join(root, 'saved.md'), 'utf8')).toBe('# Сохранено\n');
});

test('native close supports cancel, discard and saving real changes', async () => {
  await openFile('close.md', '# Исходник\n');
  await page.locator('.editor-pane:not([hidden]) .ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' правка');
  await app.evaluate(({dialog, BrowserWindow}) => {
    dialog.showMessageBox = async () => ({response: 2, checkboxChecked: false});
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror')).toContainText('правка');
  await closeNormally(1);
  await launch();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror')).not.toContainText('правка');
  await page.locator('.editor-pane:not([hidden]) .ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' сохранено');
  await closeNormally(0);
  expect(fs.readFileSync(path.join(root, 'close.md'), 'utf8')).toContain('сохранено');
  await launch();
  await expect(page.getByRole('dialog', {name: 'Восстановить черновики?'})).toBeHidden();
});

test('theme, panel toggles and table borders work in wide and narrow windows', async ({}, info) => {
  await expect(page.locator('.document-panel')).toBeHidden();
  await expect(page.locator('.actionbar').getByRole('button', {name: 'Открыть файл', exact: true}).locator('svg').first()).toBeVisible();
  await expect(page.locator('.actionbar').getByRole('button', {name: 'Открыть папку', exact: true}).locator('svg').first()).toBeVisible();
  await page.locator('.actionbar').getByRole('button', {name: 'Открыть папку', exact: true}).click();
  await page.locator('.workspace-tree .tree-row').first().click();
  await page.getByRole('button', {name: 'Свернуть дерево файлов'}).click();
  await page.locator('.top-actions').getByRole('button', {name: 'Дерево рабочего пространства', exact: true}).click();
  await expect(page.locator('.workspace-tree .tree-icon').first()).toHaveText('▸');
  await openFile('table.md', '# Таблица\n\n| Поле | Тип |\n| --- | --- |\n| code | string |\n\n<table><tr><th colspan="2">Общее</th></tr><tr><td style="background-color:#f4f5f7;color:#003366">Цвет</td><td>Значение</td></tr></table>\n');
  for (const name of ['Светлая', 'Nocturne']) {
    await page.getByRole('button', {name: 'Тема', exact: true}).click();
    await page.getByRole('dialog', {name: 'Оформление'}).getByRole('button', {name: new RegExp(name)}).click();
    await page.keyboard.press('Escape');
    const cells = page.locator('.editor-pane:not([hidden]) .ProseMirror').locator('td,th');
    const styles = await cells.evaluateAll((nodes) => nodes.map((node) => ({width: getComputedStyle(node).borderTopWidth, style: getComputedStyle(node).borderTopStyle})));
    expect(styles.length).toBeGreaterThan(4);
    expect(styles.every((style) => style.width === '1px' && style.style === 'solid')).toBe(true);
    expect(await page.locator('.editor-pane:not([hidden]) .ProseMirror').evaluate((node) => ({padding: getComputedStyle(node).paddingLeft, margin: getComputedStyle(node).marginLeft}))).toEqual({padding: '20px', margin: '0px'});
    await page.screenshot({path: info.outputPath(`${name}.png`)});
  }
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(760, 700));
  await page.locator('.top-actions').getByRole('button', {name: 'Панель документа', exact: true}).click();
  await expect(page.locator('.document-panel')).toBeVisible();
  await page.getByRole('button', {name: 'Закрыть панель документа', exact: true}).click();
  await page.locator('.top-actions').getByRole('button', {name: 'Панель документа', exact: true}).click();
  await expect(page.locator('.document-panel')).toBeVisible();
  await closeNormally();
  await launch();
  await expect(page.locator('.document-panel')).toBeVisible();
});

test('native find highlights, navigates, replaces and undoes in each editor mode', async () => {
  await openFile('find.md', '# Поиск\n\nalpha beta alpha\n');
  for (const mode of ['Визуально', 'Разметка', 'Рядом']) {
    await page.getByRole('button', {name: mode, exact: true}).click();
    const editor = page.locator('.editor-pane:not([hidden])').locator(mode === 'Визуально' ? '.ProseMirror' : '.cm-content');
    await editor.focus();
    await page.keyboard.press('Control+f');
    const search = page.getByPlaceholder('Поиск по тексту');
    await expect(search).toBeFocused();
    await search.fill('alpha');
    await expect(page.locator('.editor-pane:not([hidden])').locator(mode === 'Визуально' ? '.ProseMirror-search-match' : '.cm-searchMatch').first()).toBeVisible();
    await search.press('Enter');
    await expect(page.locator(mode === 'Визуально' ? '.ProseMirror-active-search-match' : '.cm-searchMatch-selected').first()).toBeVisible();
    await search.press('Shift+Enter');
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
    expect((await storedTabs()).find((tab) => tab.name === 'find.md')?.dirty).toBe(false);
  }
  await page.getByRole('button', {name: 'Визуально', exact: true}).click();
  await page.locator('.editor-pane:not([hidden]) .ProseMirror').evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', {key: 'а', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true})));
  const search = page.getByPlaceholder('Поиск по тексту');
  await expect(search).toBeVisible();
  await search.fill('alpha');
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror-search-match').first()).toBeVisible();
  await page.getByRole('button', {name: 'Раскрыть окно замены', exact: true}).click();
  await page.locator('[data-qa="g-md-search-replace-input"] input').fill('gamma');
  await page.locator('[data-qa="g-md-search-replace-input"] input').blur();
  await page.waitForTimeout(350); // Gravity commits the replacement field after its 300 ms debounce.
  await page.getByRole('button', {name: 'Заменить всё', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror')).toContainText('gamma beta gamma');
  await page.keyboard.press('Escape');
  await page.locator('.actionbar').getByRole('button', {name: 'Отменить', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror')).toContainText('alpha beta alpha');
});

test('outline reveals repeated headings, Setext and explicit anchors in all modes', async () => {
  const spacer = Array.from({length: 35}, (_, i) => `Абзац ${i}\n\n`).join('');
  await openFile('outline.md', `# Начало\n\n${spacer}## Повтор\n\n${spacer}<a id="явный"></a>\n\nПовтор\n------\n\n[К разделу](#явный)\n`);
  await page.locator('.top-actions').getByRole('button', {name: 'Панель документа', exact: true}).click();
  for (const mode of ['Визуально', 'Разметка', 'Рядом']) {
    await page.getByRole('button', {name: mode, exact: true}).click();
    await page.locator('.document-panel').getByRole('button', {name: 'Повтор', exact: true}).nth(1).click();
    if (mode === 'Визуально') await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror h2').nth(1)).toBeInViewport();
    else {
      await expect.poll(() => page.locator('.editor-pane:not([hidden]) .cm-scroller').evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
      if (mode === 'Рядом') await expect(page.locator('.editor-pane:not([hidden]) .fortis-preview h2').nth(1)).toBeInViewport();
    }
  }
  await page.getByRole('button', {name: 'Визуально', exact: true}).click();
  await page.locator('.document-panel').getByRole('button', {name: 'Ссылки', exact: true}).click();
  await page.locator('.document-panel').getByRole('button', {name: /К разделу/}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror h2').nth(1)).toBeInViewport();
  await expect.poll(async () => (await storedTabs()).find((tab) => tab.name === 'outline.md')?.dirty).toBe(false);
});

test('tab context menu closes groups and stops at unsaved documents without losing changes', async () => {
  for (const name of ['left.md', 'middle.md', 'right.md']) await openFile(name, `# ${name}\n`);
  const middle = page.locator('.file-tab').filter({hasText: 'middle.md'});
  await middle.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Закрыть все вкладки справа', exact: true}).click();
  await expect(page.locator('.file-tab').filter({hasText: 'right.md'})).toHaveCount(0);
  await middle.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Закрыть все вкладки слева', exact: true}).click();
  await expect(page.locator('.file-tab')).toHaveCount(1);
  await openFile('dirty.md', 'Исходный текст\n');
  await page.locator('.editor-pane:not([hidden]) .ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' изменено');
  await middle.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Закрыть все кроме активной вкладки', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Есть несохранённые изменения'});
  await expect(dialog).toContainText('dirty.md');
  await dialog.getByRole('button', {name: 'Отмена', exact: true}).click();
  await expect(page.locator('.file-tab')).toHaveCount(2);
  await middle.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Закрыть все кроме активной вкладки', exact: true}).click();
  await dialog.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('.file-tab')).toHaveCount(1);
  expect(fs.readFileSync(path.join(root, 'dirty.md'), 'utf8')).toContain('изменено');
  await middle.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Закрыть все', exact: true}).click();
  await expect(page.locator('.file-tab')).toHaveCount(0);
});

test('restored tab menus and dialogs stay above the editor toolbar', async ({}, info) => {
  await openFile('first.md', '# Первый документ\n');
  await openFile('second.md', '# Второй документ\n');
  await closeNormally();
  await launch();
  const firstTab = page.locator('.file-tab').filter({hasText: 'first.md'});
  await firstTab.click({button: 'right'});
  const menu = page.getByRole('menu', {name: 'Действия с вкладками'});
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate((node) => Array.from(node.querySelectorAll('button')).flatMap((item) => {
    const rect = item.getBoundingClientRect();
    const covered = [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].some((y) =>
      !item.contains(document.elementFromPoint(rect.left + rect.width / 2, y)));
    return covered ? [item.textContent] : [];
  }))).toEqual([]);
  await page.screenshot({path: info.outputPath('tab-menu-above-toolbar.png')});
  await page.keyboard.press('Escape');
  await page.getByTitle('Настройки Jira/Bitbucket', {exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Интеграции и настройки'});
  await expect(dialog).toBeVisible();
  const toolbar = page.locator('.editor-pane:not([hidden]) [data-layout="sticky-toolbar"]').first();
  await expect.poll(() => toolbar.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return Boolean(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.modal-backdrop'));
  })).toBe(true);
  await dialog.getByRole('button', {name: 'Закрыть', exact: true}).click();
  await firstTab.click({button: 'right'});
  // Exercise the top command which the toolbar previously intercepted.
  await menu.getByRole('menuitem', {name: 'Закрыть все', exact: true}).click();
  await expect(page.locator('.file-tab')).toHaveCount(0);
});

test('external saves are coalesced, cancellation is remembered and acceptance reads the latest file', async () => {
  await openFile('disk.md', '# Начало\n');
  const file = path.join(root, 'disk.md');
  const dialog = page.getByRole('dialog', {name: 'Файл изменён на диске'});
  fs.writeFileSync(file, '# Первая\n');
  await expect(dialog).toBeVisible();
  fs.writeFileSync(file, '# Вторая\n\nновая строка\n');
  await expect(dialog).toContainText('добавлено строк — 3');
  await dialog.getByRole('button', {name: 'Отмена', exact: true}).click();
  await page.waitForTimeout(4500);
  await expect(dialog).toBeHidden();
  // Rewriting identical content should not prompt again either.
  fs.writeFileSync(file, '# Вторая\n\nновая строка\n');
  await page.waitForTimeout(4500);
  await expect(dialog).toBeHidden();
  fs.writeFileSync(file, '# Третья\n');
  await expect(dialog).toBeVisible();
  fs.writeFileSync(file, '# Самая свежая\n');
  await dialog.getByRole('button', {name: 'Взять с диска', exact: true}).click();
  await expect(page.locator('.editor-pane:not([hidden]) .ProseMirror')).toContainText('Самая свежая');
  await page.waitForTimeout(4500);
  await expect(dialog).toBeHidden();
});

test('workspace refreshes additions, deletions and renames while preserving collapsed folders', async () => {
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'old.md'), '# Старый\n');
  await page.locator('.actionbar').getByRole('button', {name: 'Открыть папку', exact: true}).click();
  const tree = page.locator('.workspace-tree');
  await expect(tree).toContainText('old.md');
  await tree.getByRole('button', {name: /nested/}).click();
  fs.writeFileSync(path.join(root, 'new.md'), '# Новый\n');
  fs.renameSync(path.join(root, 'nested', 'old.md'), path.join(root, 'nested', 'renamed.md'));
  await expect(tree).toContainText('new.md');
  await expect(tree.getByRole('button', {name: /nested/}).locator('.tree-icon')).toHaveText('▸');
  await tree.getByRole('button', {name: /nested/}).click();
  await expect(tree).toContainText('renamed.md');
  await expect(tree).not.toContainText('old.md');
  fs.unlinkSync(path.join(root, 'new.md'));
  await expect(tree).not.toContainText('new.md');
});

test('separator stays on the wide toolbar and remains accessible when it shrinks', async () => {
  for (const mode of ['Визуально', 'Разметка']) {
    await page.getByRole('button', {name: mode, exact: true}).click();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1500, 900));
    const toolbar = page.locator('.editor-pane:not([hidden]) [data-layout="sticky-toolbar"]');
    await expect(page.locator('.editor-pane:not([hidden])').getByRole('button', {name: 'Разделитель', exact: true})).toBeVisible();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(960, 650));
    const panelToggle = page.locator('.top-actions').getByRole('button', {name: 'Панель документа', exact: true});
    if (await panelToggle.getAttribute('aria-pressed') !== 'true') await panelToggle.click();
    await expect(toolbar).toBeVisible();
    const button = page.locator('.editor-pane:not([hidden])').getByRole('button', {name: 'Разделитель', exact: true});
    if (await button.isVisible()) await button.click();
    else {
      await toolbar.getByRole('button').last().click();
      await page.getByText('Разделитель', {exact: true}).click();
    }
    await expect(page.locator('.file-tab.active')).toContainText('●');
  }
});

test('TOC links navigate inside rendered text and preview without modifying Markdown', async () => {
  const spacer = Array.from({length: 40}, (_, i) => `Абзац ${i}\n\n`).join('');
  const markdown = `# Начало\n\n[Синтаксис](#21-синтаксис-полей)\n\n[Повторный](#повтор-1)\n\n${spacer}## 2\\.1. Синтаксис полей\n\n${spacer}## Повтор\n\n${spacer}## Повтор\n`;
  await openFile('toc.md', markdown);
  for (const mode of ['Визуально', 'Рядом']) {
    await page.getByRole('button', {name: mode, exact: true}).click();
    const content = page.locator(mode === 'Визуально' ? '.editor-pane:not([hidden]) .ProseMirror' : '.editor-pane:not([hidden]) .fortis-preview');
    await content.getByRole('link', {name: 'Синтаксис', exact: true}).click();
    await expect(content.locator('h2').first()).toBeInViewport();
    await content.getByRole('link', {name: 'Повторный', exact: true}).click();
    await expect(content.locator('h2').last()).toBeInViewport();
    expect(page.url()).toBe('fortis://app/index.html');
  }
  await expect.poll(async () => (await storedTabs()).find((tab) => tab.name === 'toc.md')?.markdown).toBe(markdown);
  await expect.poll(async () => (await storedTabs()).find((tab) => tab.name === 'toc.md')?.dirty).toBe(false);
});

test('native context menu copies, cuts and pastes in both editor modes', async () => {
  await app.evaluate(({Menu}) => {
    Menu.prototype.popup = function () {(globalThis as MenuTestGlobal).__fortisTestMenu = this;};
  });
  for (const mode of ['Визуально', 'Разметка']) {
    await openFile(`clipboard-${mode}.md`, 'Текст для буфера\n');
    await page.getByRole('button', {name: mode, exact: true}).click();
    const content = page.locator(mode === 'Визуально' ? '.editor-pane:not([hidden]) .ProseMirror' : '.editor-pane:not([hidden]) .cm-content');
    await content.click();
    await page.keyboard.press('Control+a');
    await content.locator(mode === 'Визуально' ? 'p' : '.cm-line').first().click({button: 'right', position: {x: 12, y: 8}});
    await expect.poll(() => app.evaluate(() => (globalThis as MenuTestGlobal).__fortisTestMenu?.items.map((item) => item.label))).toEqual(['Скопировать', 'Вырезать', 'Вставить']);
    const invoke = async (label: string) => app.evaluate(({BrowserWindow}, name) => {
      const menu = (globalThis as MenuTestGlobal).__fortisTestMenu;
      const item = menu?.items.find((item) => item.label === name);
      if (!item?.enabled) throw new Error(`Disabled clipboard action: ${name}`);
      // Electron dispatches built-in roles in native code, outside MenuItem.click.
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      if (item.role === 'copy') contents.copy();
      else if (item.role === 'cut') contents.cut();
      else if (item.role === 'paste') contents.paste();
      else throw new Error(`Unexpected clipboard role: ${item.role}`);
    }, label);
    await invoke('Скопировать');
    await expect.poll(() => app.evaluate(({clipboard}) => clipboard.readText())).toContain('Текст для буфера');
    await invoke('Вырезать');
    await expect(content).not.toContainText('Текст для буфера');
    await content.click({button: 'right'});
    await invoke('Вставить');
    await expect(content).toContainText('Текст для буфера');
  }
});
