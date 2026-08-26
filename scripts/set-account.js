#!/usr/bin/env node
'use strict';

/**
 * Подставляет ник GitHub в метаданные проекта.
 *
 *   node scripts/set-account.js мой-ник
 *
 * Пакету .deb нужны адрес проекта и сопровождающий, а знать их заранее
 * неоткуда — до создания репозитория в package.json стоит метка
 * GITHUB_ACCOUNT. Эта команда меняет её на настоящий ник.
 */

const fs = require('node:fs');
const path = require('node:path');

const account = process.argv[2];
if (!account || !/^[A-Za-z0-9-]+$/.test(account)) {
  console.error('Укажите ник GitHub: node scripts/set-account.js мой-ник');
  process.exit(1);
}

const root = path.join(__dirname, '..');
let changed = 0;

for (const name of ['package.json', 'README.md', 'AGENTS.md']) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.split('GITHUB_ACCOUNT').join(account);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log('обновлён ' + name);
    changed++;
  }
}

console.log(changed ? 'Готово.' : 'Метка GITHUB_ACCOUNT нигде не найдена — видимо, уже подставлено.');
