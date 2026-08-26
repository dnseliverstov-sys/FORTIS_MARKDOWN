'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Сертификата разработчика у сборки нет, и electron-builder подпись пропускает.
 * Но от готового бинарника Electron остаётся подпись компоновщика, которая после
 * переупаковки уже не сходится, — на Apple Silicon такое приложение система
 * просто не запустит. Поэтому подписываем ad-hoc: подпись без удостоверения,
 * которой macOS хватает, чтобы приложение считалось целым.
 *
 * Gatekeeper это не отменяет: скачанное приложение всё равно попросит снять
 * карантин (см. README).
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • ad-hoc подпись поставлена  ' + appPath);
};
