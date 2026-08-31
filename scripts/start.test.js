'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MINIMUM_NODE,
  binaryLooksUsable,
  parseArguments,
  rendererFingerprint,
  runtimeFingerprint,
  versionAtLeast
} = require('./start');

test('минимальная версия Node принимается включительно', () => {
  assert.equal(MINIMUM_NODE, '22.12.0');
  assert.equal(versionAtLeast('22.12.0', MINIMUM_NODE), true);
  assert.equal(versionAtLeast('24.0.0', MINIMUM_NODE), true);
  assert.equal(versionAtLeast('22.11.9', MINIMUM_NODE), false);
  assert.equal(versionAtLeast('20.20.0', MINIMUM_NODE), false);
});

test('prepare-only не передаётся Electron, остальные аргументы сохраняют порядок', () => {
  assert.deepEqual(
    parseArguments(['--remote-debugging-port=9333', '--prepare-only', '--disable-gpu']),
    {
      prepareOnly: true,
      electronArgs: ['--remote-debugging-port=9333', '--disable-gpu']
    }
  );
});

test('отпечаток зависит от lock-файла, платформы, архитектуры и ABI', () => {
  const base = runtimeFingerprint('package', 'lock-a', { platform: 'win32', arch: 'x64', modules: '137' });
  assert.equal(base, runtimeFingerprint('package', 'lock-a', { platform: 'win32', arch: 'x64', modules: '137' }));
  assert.notEqual(base, runtimeFingerprint('package', 'lock-b', { platform: 'win32', arch: 'x64', modules: '137' }));
  assert.notEqual(base, runtimeFingerprint('package', 'lock-a', { platform: 'darwin', arch: 'x64', modules: '137' }));
  assert.notEqual(base, runtimeFingerprint('package', 'lock-a', { platform: 'win32', arch: 'arm64', modules: '137' }));
  assert.notEqual(base, runtimeFingerprint('package', 'lock-a', { platform: 'win32', arch: 'x64', modules: '138' }));
});

test('отпечаток renderer детерминирован и зависит от package/lock', () => {
  const base = rendererFingerprint(Buffer.from('package'), Buffer.from('lock-a'));
  assert.equal(base, rendererFingerprint(Buffer.from('package'), Buffer.from('lock-a')));
  assert.notEqual(base, rendererFingerprint(Buffer.from('package'), Buffer.from('lock-b')));
});

test('проверка бинарника отклоняет отсутствующий и слишком короткий файл', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fortis-launcher-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tiny = path.join(dir, 'electron');
  const large = path.join(dir, 'electron-large');
  fs.writeFileSync(tiny, 'broken');
  fs.writeFileSync(large, Buffer.alloc(4 * 1024));

  assert.equal(binaryLooksUsable(path.join(dir, 'missing')), false);
  assert.equal(binaryLooksUsable(tiny), false);
  assert.equal(binaryLooksUsable(large), true);
});
