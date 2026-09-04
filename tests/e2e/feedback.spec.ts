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

async function launch() {
  app = await electron.launch({args: [path.resolve('app/main.js')], env: {...globalThis.process.env, FORTIS_E2E_ROOT: root, FORTIS_E2E_USER_DATA: userData}});
  electronProcess = app.process();
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
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
