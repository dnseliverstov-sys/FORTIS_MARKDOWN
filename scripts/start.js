#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const LOCK_FILE = path.join(ROOT, 'package-lock.json');
const MODULES_DIR = path.join(ROOT, 'node_modules');
const STATE_FILE = path.join(MODULES_DIR, '.fortis-runtime.json');
const MINIMUM_NODE = '22.12.0';

function versionAtLeast(current, minimum) {
  const left = String(current).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(minimum).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if ((left[i] || 0) > (right[i] || 0)) return true;
    if ((left[i] || 0) < (right[i] || 0)) return false;
  }
  return true;
}

function runtimeFingerprint(packageData, lockData, runtime = {}) {
  const hash = crypto.createHash('sha256');
  hash.update('fortis-runtime-v1\0');
  hash.update(packageData);
  hash.update('\0');
  hash.update(lockData);
  hash.update('\0');
  hash.update(JSON.stringify({
    platform: runtime.platform || process.platform,
    arch: runtime.arch || process.arch,
    modules: runtime.modules || process.versions.modules
  }));
  return hash.digest('hex');
}

function parseArguments(args) {
  const electronArgs = [];
  let prepareOnly = false;
  for (const arg of args) {
    if (arg === '--prepare-only') prepareOnly = true;
    else electronArgs.push(arg);
  }
  return { prepareOnly, electronArgs };
}

function fail(message, details = []) {
  console.error('\nFORTIS: ' + message);
  for (const line of details) console.error('  ' + line);
  console.error('');
  process.exitCode = 1;
}

function checkNodeVersion() {
  if (versionAtLeast(process.versions.node, MINIMUM_NODE)) return true;
  fail('нужен Node.js ' + MINIMUM_NODE + ' или новее.', [
    'Сейчас используется Node.js ' + process.versions.node + '.',
    'Установите актуальную LTS-версию с https://nodejs.org и повторите npm start.'
  ]);
  return false;
}

function readRequiredFile(file, label) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    fail('не найден или не читается ' + label + '.', [
      'Проверьте, что репозиторий склонирован полностью.',
      error.message
    ]);
    return null;
  }
}

function readRuntimeState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function npmCliPath() {
  const cli = process.env.npm_execpath;
  if (cli && fs.existsSync(cli)) return cli;
  fail('не удалось найти npm, которым была запущена команда.', [
    'Запускайте приложение командой npm start из корня репозитория.'
  ]);
  return null;
}

function runNpm(cli, args, stdio) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio,
    windowsHide: true
  });
}

function dependencyTreeIsHealthy(cli) {
  if (!fs.existsSync(MODULES_DIR)) return false;
  const result = runNpm(cli, ['ls', '--depth=0', '--include=dev', '--json'], 'ignore');
  return !result.error && result.status === 0;
}

function writeRuntimeState(fingerprint) {
  const temporary = STATE_FILE + '.tmp-' + process.pid;
  const state = JSON.stringify({ fingerprint, preparedAt: new Date().toISOString() }, null, 2) + '\n';
  try {
    fs.writeFileSync(temporary, state, 'utf8');
    fs.renameSync(temporary, STATE_FILE);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    console.warn('FORTIS: не удалось записать служебную отметку; следующий запуск повторит проверку.');
    console.warn('  ' + error.message);
  }
}

function installDependencies(cli, fingerprint) {
  console.log('FORTIS: подготавливаю зависимости для этой версии проекта...');
  const result = runNpm(cli, ['ci', '--include=dev', '--no-audit', '--no-fund'], 'inherit');
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : 'npm ci завершился с кодом ' + result.status + '.';
    fail('не удалось установить зависимости.', [
      reason,
      'Закройте уже запущенный FORTIS, если он открыт.',
      'Проверьте интернет и настройки proxy: npm config get proxy.',
      'Убедитесь, что package.json и package-lock.json взяты из одного коммита.'
    ]);
    return false;
  }
  if (!dependencyTreeIsHealthy(cli)) {
    fail('npm завершил установку, но дерево зависимостей повреждено.', [
      'Повторите npm start. Если ошибка сохранится, проверьте права на папку проекта.'
    ]);
    return false;
  }
  writeRuntimeState(fingerprint);
  return true;
}

function ensureDependencies(cli, fingerprint) {
  const state = readRuntimeState();
  if (state && state.fingerprint === fingerprint && dependencyTreeIsHealthy(cli)) {
    console.log('FORTIS: зависимости актуальны.');
    return true;
  }
  return installDependencies(cli, fingerprint);
}

function electronModulePath() {
  return require.resolve('electron', { paths: [ROOT] });
}

function loadElectronBinary() {
  const moduleFile = electronModulePath();
  delete require.cache[moduleFile];
  return { moduleFile, binary: require(moduleFile) };
}

function binaryLooksUsable(file) {
  try {
    const stat = fs.statSync(file);
    // На macOS основной executable заметно меньше Chromium Framework, поэтому
    // здесь ловим только явно пустой/обрезанный файл, не сравнивая размеры ОС.
    return stat.isFile() && stat.size >= 4 * 1024;
  } catch {
    return false;
  }
}

function resetElectronRuntime(moduleFile) {
  const packageDir = path.dirname(moduleFile);
  fs.rmSync(path.join(packageDir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(packageDir, 'path.txt'), { force: true });
  delete require.cache[moduleFile];
}

function ensureElectronBinary() {
  console.log('FORTIS: проверяю Electron; при первом запуске будет скачан системный бинарник...');
  try {
    let loaded = loadElectronBinary();
    if (!binaryLooksUsable(loaded.binary)) {
      console.log('FORTIS: бинарник Electron отсутствует или повреждён, скачиваю заново...');
      resetElectronRuntime(loaded.moduleFile);
      loaded = loadElectronBinary();
    }
    if (!binaryLooksUsable(loaded.binary)) throw new Error('скачанный бинарник Electron не прошёл проверку');
    return loaded.binary;
  } catch (error) {
    fail('не удалось подготовить Electron.', [
      error.message,
      'Для первого запуска нужен доступ к интернету и GitHub Releases.',
      'Если используется proxy, настройте npm/ELECTRON_MIRROR и повторите npm start.'
    ]);
    return null;
  }
}

function linuxHasDisplay() {
  if (process.platform !== 'linux') return true;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  try {
    return fs.readdirSync('/tmp/.X11-unix').some((name) => /^X\d+$/.test(name));
  } catch {
    return false;
  }
}

function launchElectron(binary, args) {
  if (!linuxHasDisplay()) {
    fail('не найден графический сеанс Linux.', [
      'Запустите команду с рабочего стола или используйте: xvfb-run -a npm start'
    ]);
    return;
  }

  console.log('FORTIS: запускаю приложение...');
  const child = spawn(binary, ['.', ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false
  });

  let stopping = false;
  const forward = (signal) => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => forward(signal));

  child.once('error', (error) => {
    fail('Electron не удалось запустить.', [
      error.message,
      'Закройте уже запущенный FORTIS и проверьте права на папку проекта.'
    ]);
  });
  child.once('exit', (code, signal) => {
    if (typeof code === 'number') process.exitCode = code;
    else if (signal === 'SIGINT') process.exitCode = 130;
    else if (signal === 'SIGTERM') process.exitCode = 143;
    else process.exitCode = 1;
  });
}

function main() {
  if (!checkNodeVersion()) return;

  const packageData = readRequiredFile(PACKAGE_FILE, 'package.json');
  const lockData = readRequiredFile(LOCK_FILE, 'package-lock.json');
  if (!packageData || !lockData) return;

  const cli = npmCliPath();
  if (!cli) return;

  const fingerprint = runtimeFingerprint(packageData, lockData);
  if (!ensureDependencies(cli, fingerprint)) return;

  const binary = ensureElectronBinary();
  if (!binary) return;

  const options = parseArguments(process.argv.slice(2));
  if (options.prepareOnly) {
    console.log('FORTIS: окружение готово (' + process.platform + ', ' + process.arch + ').');
    return;
  }
  launchElectron(binary, options.electronArgs);
}

if (require.main === module) main();

module.exports = {
  MINIMUM_NODE,
  binaryLooksUsable,
  parseArguments,
  runtimeFingerprint,
  versionAtLeast
};
