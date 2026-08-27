#!/usr/bin/env python3
"""Переносит правки из src/ в собранную страницу app/index.html.

Страница собрана генератором и хранит исходник прототипа внутри себя —
в блоке <script type="__bundler/template"> в виде строки JSON. Код и стили
редактора лежат там ровно теми же байтами, что и в src/, только внешние
ресурсы заменены на встроенные. Поэтому правка src/ сама по себе ни на что
не влияет: её надо перенести сюда.

  python3 scripts/sync-bundle.py           перенести src/ → app/index.html
  python3 scripts/sync-bundle.py --check   проверить, что они не разошлись

Переносятся единственный инлайновый <script> (вся логика редактора) и
последние N блоков <style> — те, что пришли из исходника; идущие перед ними
блоки генератор добавил сам, там встроенные шрифты, их трогать нельзя.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src' / 'FORTIS Markdown Editor.dc.html'
BUNDLE = ROOT / 'app' / 'index.html'
CHR_BS = chr(92)

TEMPLATE_RE = re.compile(r'(<script[^>]*type="__bundler/template"[^>]*>)(.*?)(</script>)', re.S)
SCRIPT_RE = re.compile(r'(<script(?![^>]*\bsrc=)[^>]*>)(.*?)(</script>)', re.S)
STYLE_RE = re.compile(r'(<style[^>]*>)(.*?)(</style>)', re.S)


def encode(text):
    """Кодирует шаблон для вставки обратно в страницу.

    Последовательность "</" экранируется не для красоты: внутри шаблона есть
    </script>, и в готовой странице он оборвал бы блок <script> на середине —
    страница перестала бы открываться. Для JSON "<\\u002Fscript>" и
    "</script>" — одна и та же строка, поэтому смысл не меняется.

    ensure_ascii=False оставляет кириллицу как есть, иначе файл распухает.
    """
    out = json.dumps(text, ensure_ascii=False).replace('</', '<' + CHR_BS + 'u002F')
    # Если это не так, страница молча превратится в обломок.
    assert '</' not in out, 'в закодированном шаблоне осталась последовательность </'
    assert json.loads(out) == text, 'после кодирования шаблон читается иначе'
    return out


def parts(text, rx):
    return [(m.start(2), m.end(2), m.group(2)) for m in rx.finditer(text)]


def splice(text, edits):
    """Заменяет куски текста по смещениям, начиная с конца — чтобы не сползали."""
    for start, end, new in sorted(edits, key=lambda e: -e[0]):
        text = text[:start] + new + text[end:]
    return text


def main() -> int:
    check = '--check' in sys.argv
    src = SRC.read_text()
    page = BUNDLE.read_text()

    tm = TEMPLATE_RE.search(page)
    if not tm:
        print('в app/index.html нет блока __bundler/template — формат сборки изменился')
        return 2
    tpl = json.loads(tm.group(2))

    src_scripts, tpl_scripts = parts(src, SCRIPT_RE), parts(tpl, SCRIPT_RE)
    src_styles, tpl_styles = parts(src, STYLE_RE), parts(tpl, STYLE_RE)

    if len(src_scripts) != 1 or len(tpl_scripts) != 1:
        print(f'ожидался ровно один инлайновый <script> с каждой стороны, '
              f'а их {len(src_scripts)} и {len(tpl_scripts)}')
        return 2
    if len(tpl_styles) < len(src_styles):
        print(f'блоков <style> в сборке меньше, чем в исходнике: '
              f'{len(tpl_styles)} против {len(src_styles)}')
        return 2

    # Блоки из исходника идут в сборке последними.
    targets = tpl_styles[len(tpl_styles) - len(src_styles):]

    edits, diffs = [], []
    for (s, e, old), (_, _, new) in zip([tpl_scripts[0]], [src_scripts[0]]):
        if old != new:
            diffs.append(f'логика редактора: {len(old)} → {len(new)} символов')
            edits.append((s, e, new))
    for (s, e, old), (_, _, new) in zip(targets, src_styles):
        if old != new:
            diffs.append(f'стили: {len(old)} → {len(new)} символов')
            edits.append((s, e, new))

    if not diffs:
        print('сборка совпадает с исходником — переносить нечего')
        return 0

    if check:
        print('РАСХОЖДЕНИЕ, сборка отстала от исходника:')
        for d in diffs:
            print('  ', d)
        print('Выполните: python3 scripts/sync-bundle.py')
        return 1

    encoded = '\n' + encode(splice(tpl, edits))
    new_page = page[:tm.start(2)] + encoded + page[tm.end(2):]
    BUNDLE.write_text(new_page)
    for d in diffs:
        print('перенесено —', d)
    print(f'app/index.html: {len(page)} → {len(new_page)} символов')
    return 0


if __name__ == '__main__':
    sys.exit(main())
