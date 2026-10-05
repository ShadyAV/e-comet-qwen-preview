# e-Comet для Qwen Code — preview

Тестовый плагин e-Comet для Qwen Code на Windows, Linux и macOS. Одна ссылка для установки: Qwen сам выбирает пакет для вашей системы. Приложение Qwen менять не нужно.

## Установка

Нужны Qwen Code 0.25.0, Node.js 22+ в PATH, аккаунт e-Comet и браузерное расширение e-Comet. На Windows используется штатный Windows PowerShell. Устанавливать npm-зависимости плагина не нужно.

1. В **Plugins → Extensions** отключите прежний плагин e-Comet, если он установлен. Если `e-comet` или `e-comet-local` добавлялись вручную в MCP, уберите эти дубли: они перекрывают серверы плагина.
2. Нажмите **Add**, вставьте `https://github.com/ShadyAV/e-comet-qwen-preview` в **Source** и нажмите **Install**. Подтвердите установку плагина и его хука.
3. Перезапустите Qwen. В **Plugins → MCP → e-comet** завершите **Authenticate**, если Qwen запросит вход.
4. В новом чате попросите: «Найди на WB тушёнку, одна страница. Покажи первые пять товаров с артикулами».

Модель подключается отдельно в Qwen. Плагин не содержит ключей, готовых сессий или авторизации.

Для обновления используйте обновление расширения в Qwen и перезапустите приложение. Через CLI:

```sh
qwen extensions update e-comet-qwen-preview
```

Установка через CLI использует ту же ссылку:

```sh
qwen extensions install https://github.com/ShadyAV/e-comet-qwen-preview
```

## Что проверено

Пользователь подтвердил живой поиск «тушёнка» на WB в штатном Qwen Desktop на Windows с preview.2: получена страница товаров с артикулами.

В preview.3 изменена упаковка. На Windows проверены установка собранного ZIP штатным Qwen 0.25.0, запуск локального MCP и передача одноразового разрешения через настоящий механизм хуков Qwen. Повторное использование, другой чат, другой инструмент и разрешение от модели отклоняются. Проверки запуска пакетов для Windows, Linux и macOS описаны в [CI](https://github.com/ShadyAV/e-comet-qwen-preview/actions/workflows/validate.yml); они не заменяют проверку Desktop и живого WB на каждой системе. Desktop на Linux и macOS ещё не проверен. Отправка обращения с историей чата в поддержку не настроена.

## Сборка и выпуск

`qwen/` содержит один общий адаптер; `mcp/` и `hooks/` — компоненты e-Comet. Для сборки нужен Python 3.10+ со стандартной библиотекой; для проверок — Node.js 22+:

```sh
python scripts/build_archives.py
node --test tests/package.test.mjs
```

В `dist/` появятся `win32.e-comet-qwen-preview.zip`, `linux.e-comet-qwen-preview.zip` и `darwin.e-comet-qwen-preview.zip`. В каждом есть корневой `qwen-extension.json`, метаданные MCP и диагностический справочник; тесты и CI в архивы не входят. JS-код одинаковый. Отличается только `hook.shell`: `powershell` на Windows, штатная оболочка Qwen на Unix.

CI устанавливает неизменённый `@qwen-code/qwen-code@0.25.0` для проверки настоящего установщика и механизма хуков. Для той же проверки локально задайте `ECOMET_QWEN_CLI` — путь к его `cli-entry.js`. Без этой переменной локальная проверка Qwen пропускается с явным сообщением. Все проверки используют временные профили и синтетическое разрешение, без аккаунтов и запросов к маркетплейсам.

Установочный источник — три подготовленных ZIP в GitHub Release, отмеченном **Latest**. Название версии остаётся preview, но сам GitHub Release не помечается **Pre-release**: Qwen 0.25.0 по умолчанию проверяет Latest. Это [штатный механизм выбора платформы Qwen](https://qwenlm.github.io/qwen-code-docs/en/users/extension/extension-releasing/).

Исходники репозитория и автоматические архивы **Source code** не являются установочными пакетами: шаблон манифеста лежит в `packaging/`. Если Qwen не смог получить Release и перешёл к исходникам, установка завершится ошибкой отсутствующего манифеста. Для ручной установки скачайте подходящий ZIP из [Releases](https://github.com/ShadyAV/e-comet-qwen-preview/releases) и выполните `qwen extensions install <путь-к-ZIP>`.

После исправления обработки `PreToolUse.updatedInput` в Qwen этот обход можно будет убрать после проверки совместимости. Пакет не включает автоматическое переключение между обходом и штатным хуком.

Основа: [e-comet/skills](https://github.com/e-comet/skills). Лицензия: Apache-2.0.
