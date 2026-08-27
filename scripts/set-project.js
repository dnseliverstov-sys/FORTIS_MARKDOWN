#!/usr/bin/env node
'use strict';

/**
 * Адрес проекта для метаданных пакетов Linux.
 *
 *   node scripts/set-project.js https://адрес/проекта   записать адрес
 *   node scripts/set-project.js --check                 проверить, что он задан
 *
 * Форматы .deb и .rpm хранят адрес проекта в своих метаданных, и его видит
 * каждый, кто установит пакет. Заранее адрес знать неоткуда, поэтому поле
 * homepage в package.json оставлено пустым. Проверка стоит в сборке Linux:
 * без неё в .rpm молча попадает выдуманный адрес, который подставляет
 * упаковщик. Для macOS и Windows адрес не нужен вовсе.
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const arg = process.argv[2];

if (arg === '--check') {
  if (pkg.homepage && /^https?:\/\/.+/.test(pkg.homepage)) {
    process.exit(0);
  }
  console.error('');
  console.error('  Не задан адрес проекта, а пакетам .deb и .rpm он нужен:');
  console.error('  без него в метаданные попадёт выдуманный адрес.');
  console.error('');
  console.error('    npm run project -- https://адрес/проекта');
  console.error('');
  console.error('  Годится любой рабочий адрес: страница проекта, внутренний');
  console.error('  портал, репозиторий. Для macOS и Windows это не нужно.');
  console.error('');
  process.exit(1);
}

if (!arg || !/^https?:\/\/.+/.test(arg)) {
  console.error('Укажите адрес: node scripts/set-project.js https://адрес/проекта');
  process.exit(1);
}

pkg.homepage = arg;
fs.writeFileSync(FILE, JSON.stringify(pkg, null, 2) + '\n');
console.log('Адрес проекта записан: ' + arg);
