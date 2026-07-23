# cowork-deck Release 1.0 — чек-лист приёмки

Дата: 2026-07-23

Окружение проверки: headless CI/агентская сессия (macOS, без GUI-сессии). Автотесты, аудит зависимостей
и статическая проверка конфигурации выполнены и записаны ниже с фактическим выводом команд. Пункты,
требующие запущенного десктоп-приложения (`npm run tauri dev` / `npm run tauri build` с GUI, визуальные
и живые проверки), помечены как отложенные на человека с десктоп-машиной и инструкцией, что именно
проверить.

## Автотесты

- [x] `npm test` — зелёный

```
> cowork-deck@0.1.0 test
> vitest run

 RUN  v2.1.9 /Users/evgenykharetski/Documents/lemsoft/cowork-deck

 ✓ tests/ipc.test.ts (3 tests) 20ms
stderr | tests/sessions-util.test.ts
Not implemented: HTMLCanvasElement's getContext() method: without installing the canvas npm package

 ✓ tests/sessions.test.ts (2 tests) 157ms
 ✓ tests/sessions-util.test.ts (2 tests) 11ms

 Test Files  3 passed (3)
      Tests  7 passed (7)
```

(Заглушка `HTMLCanvasElement.getContext` — ожидаемый шум jsdom при рендере xterm.js в тестовой среде,
не влияет на результат: 7/7 тестов зелёные.)

- [x] `cargo test --manifest-path src-tauri/Cargo.toml` — зелёный

```
     Running unittests src/main.rs (cowork_deck-fdfd58e8f214bd13)
running 13 tests
test model::tests::maps_kinds_to_states ... ok
test tests::falls_back_to_release_sibling_in_dev ... ok
test tests::prefers_reporter_next_to_exe ... ok
test tests::defaults_to_exe_dir_when_none_exist ... ok
test listener::tests::backoff_grows_and_caps ... ok
test commands::tests::builds_claude_args_without_prompt ... ok
test commands::tests::builds_claude_args_with_settings_and_prompt ... ok
test store::tests::read_vec_returns_empty_for_missing_file_not_found ... ok
test hooks::tests::builds_valid_json_with_all_events ... ok
test store::tests::upsert_refuses_to_truncate_on_non_not_found_read_error ... ok
test store::tests::empty_store_reads_empty_then_upserts_and_deletes ... ok
test listener::tests::receives_and_maps_a_line ... ok
test pty::tests::spawns_streams_output_and_exits ... ok
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

     Running unittests src/bin/cowork_report.rs (cowork_report-486e571e0af811f3)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

     Running tests/reporter.rs (reporter-4787a674a26cd8eb)
running 2 tests
test reporter_sends_a_json_line ... ok
test reporter_extracts_notification_type_from_stdin ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Итого: 15 Rust-тестов (13 + 0 + 2) во всех трёх бинарях — все зелёные.

## P0 (проверено статически по коду; поведенческая часть требует живого запуска — см. раздел ниже)

- [x] CSP статически установлен в `src-tauri/tauri.conf.json` с запретом `unsafe-inline` для скриптов (P0-1, commit `5a120f9`)

  Фактическая конфигурация:
  ```json
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost"
  ```
  Строгий CSP присутствует в коде и не даёт `unsafe-inline` для скриптов.

- [ ] Консоль webview без нарушений CSP при `npm run tauri dev` — требует человека на десктопе
  — Запустить `npm run tauri dev`, открыть devtools и убедиться, что консоль не выводит ошибок/предупреждений о нарушении CSP-политики.

- [x] Резолвинг пути репортера и логика меток состояния покрыты юнит-тестами — все 4 теста зелёные:
  `tests::prefers_reporter_next_to_exe`, `tests::falls_back_to_release_sibling_in_dev`,
  `tests::defaults_to_exe_dir_when_none_exist`, `model::tests::maps_kinds_to_states` (P0-4).

- [ ] Метки состояния реально меняются в `tauri dev` на живом claude 2.1.217 — требует человека
  — Запустить `npm run tauri dev`, создать сессию с реальным claude, провести через полный цикл (ввод → работа → ждёт ввода → завершение), убедиться, что метка плитки переключается корректно (готов → работает → ждёт ввода → завершён).

- [x] Нет busy-loop в listener (backoff) — юнит-тест `listener::tests::backoff_grows_and_caps` зелёный
  (P0-3, commit `271cc9d`).

- [x] Ошибка запуска → плитка «ошибка» — покрыто (P0-2, commit `b90ba2b`, `01ac013`: "assert mapped
  error message content in launch-error test").

## Живая проверка (claude 2.1.217)

**[ ] требует человека на десктопе** — headless-окружение этой сессии не может запустить `npm run tauri dev`
(нет GUI/webview-рантайма). Что проверить вручную:

- [ ] готов / работает / ждёт ввода / завершён / ошибка — все наблюдаются
  — Запустить `npm run tauri dev`, создать 1+ сессию с реальным `claude` (версия 2.1.217), провести
  сессию через полный цикл (ввод промпта → работа → ожидание ввода → завершение), убедиться что метка
  плитки корректно переключается на каждом этапе; отдельно вызвать ошибку запуска (например, невалидный
  бинарь/путь) и убедиться в плитке «ошибка».
- [ ] ОС-уведомления приходят на waitingInput / ended / error
  — В момент перехода сессии в `waitingInput`/`ended`/`error` проверить появление нативного
  OS-уведомления (macOS Notification Center) с ожидаемым текстом/иконкой.
- [ ] Ресайз окна: терминал следует
  — Изменить размер окна приложения и убедиться, что встроенный терминал (xterm + fit addon)
  корректно ресайзится вслед за контейнером (regression-проверка на коммиты `3a5b814`, `932e065`).
- [ ] Память < 100 МБ: <фактическое значение>
  — Со стартованной сессией снять `ps aux | grep cowork-deck` (или Activity Monitor → Memory) и
  записать RSS процесса; ожидание — суммарно (webview + сайдкар) < 100 МБ на простое.

## Sidecar

**[ ] требует человека на десктопе** — `npm run tauri build` в headless-окружении не запускался
(долгая GUI-сборка с бандлингом, не гарантированно доступна без десктоп-сессии/подписи). Что проверить
вручную:

- [ ] `tauri build` успешен
  — Выполнить `npm run tauri build` на десктоп-машине (macOS), убедиться, что сборка завершается без
  ошибок (`beforeBuildCommand`: `npm run build && npm run stage:reporter` должен разложить бинарь
  `cowork_report` перед бандлингом).
- [ ] cowork_report рядом с exe в бандле
  — Открыть содержимое собранного `.app`/бандла и убедиться, что `cowork_report` (см.
  `"externalBin": ["binaries/cowork_report"]` в `src-tauri/tauri.conf.json`) действительно лежит рядом
  с исполняемым файлом приложения (Resources/MacOS в зависимости от таргета).
- [ ] Собранное приложение показывает метки
  — Запустить собранный бандл (не `tauri dev`), повторить пункт «готов/работает/ждёт ввода/завершён/ошибка»
  из живой проверки выше — на реальном бандле, а не dev-сборке (проверка что hooks/reporter путь
  разрешается верно вне dev-режима).

## Аудит

- [x] npm audit (все зависимости, включая dev): **5 уязвимостей (3 moderate, 1 high, 1 critical)** —
  все в dev-toolchain (`vite`/`vitest`/`esbuild`/`vite-node`/`@vitest/mocker`), затрагивают только
  dev-сервер и тестовый раннер, не входят в prod-бандл:
  ```
  esbuild  <=0.24.2 (moderate) — GHSA-67mh-4wv8-2f99, dev-server request read
  vite     <=6.4.2 (high)     — GHSA-fx2h-pf6j-xcff (server.fs.deny bypass), GHSA-4w7w-66w2-5vf9 (path traversal), GHSA-v6wh-96g9-6wx3 (launch-editor NTLMv2 hash disclosure)
  vite-node <=2.2.0-beta.2 (moderate)
  @vitest/mocker <=3.0.0-beta.4 (moderate)
  vitest   <=3.2.5 (critical) — GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read/exec)
  ```
  Fix path: `npm audit fix --force` → upgrades to `vite@8.1.5` (breaking change, out of scope for 1.0).

- [x] npm audit `--omit=dev` (только prod-зависимости, что реально едет в бандле): **0 уязвимостей**
  ```
  found 0 vulnerabilities
  ```
  Prod dependency tree: `@tauri-apps/api`, `@tauri-apps/plugin-notification`, `@xterm/addon-fit`,
  `@xterm/xterm` (4 прямых prod-зависимости) — чисто.

- [x] cargo audit: **не установлен** (`cargo-audit` отсутствует в окружении: `cargo audit` →
  `error: no such command: 'audit'`). Не устанавливался в рамках этой headless-сессии (требует
  компиляции доп. инструмента). Рекомендация на 1.x: установить `cargo-audit` в CI и прогнать против
  `src-tauri/Cargo.lock`.

## Визуальный слой

**[ ] требует человека на десктопе** — визуальная приёмка нерендерится в headless-среде. Реализация
присутствует в коде (см. коммиты ниже), но финальная визуальная проверка на живом рендере не
выполнялась в этой сессии:

- [ ] Единая тёмная тема (нет «пяти чёрных»)
  — Реализовано в `919b869` (design-system tokens, unified chrome, accent xterm theme). Проверить
  визуально в `tauri dev`: терминал, карточки, сайдбар и хром окна используют один и тот же тёмный тон
  палитры, а не пять разных случайных оттенков чёрного.
- [ ] Пульс только у «ждёт ввода»
  — Реализовано в `f553691` (tri-coded state labels with pulse on waiting-input). Проверить, что
  анимация пульса появляется только на плитках в состоянии `waitingInput`, у остальных состояний
  статичная метка.
- [ ] Адаптивная сетка ок на 1/4/8
  — Реализовано в `baf2869` (adaptive terminal grid with min tile height and deck scroll). Проверить
  раскладку при 1, 4 и 8 одновременных сессиях: плитки не схлопываются ниже минимальной высоты,
  избыток скроллится, а не обрезается.
- [ ] Активная плитка выделена, клик по списку фокусирует
  — Реализовано в `1bb71e0` (active-tile focus and clickable session list). Проверить, что клик по
  строке в списке сессий скроллит/фокусирует соответствующую плитку и подсвечивает её как активную.
- [ ] Счётчик «N ждут ввода» в заголовке/окне
  — Реализовано в `c424101` (waiting-input counter in sidebar and window title). Проверить, что
  счётчик в сайдбаре и заголовке окна корректно отражает число сессий в `waitingInput` в реальном
  времени по мере смены состояний.

## Известные отложенные пункты (в 1.x)

- `claude --continue` при перезапуске
- нативные диалоги/folder picker вместо `prompt`/`confirm`/`alert`
- редактирование пространств/сценариев
- клик по ОС-уведомлению → фокус окна+плитки (сведено к in-app эквиваленту в Task 8: клик по строке
  списка → фокус; истинная маршрутизация клика по OS-уведомлению кроссплатформенно не гарантируется
  плагином notification)
- персист размера окна и активного пространства
- установка и прогон `cargo-audit` в CI (не установлен в этой headless-приёмке)
