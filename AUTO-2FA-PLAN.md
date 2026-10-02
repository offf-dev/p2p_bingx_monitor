# Авто-2FA (TOTP) — план фичи

**Статус:** реализовано 2026-10-02 (`content.js` + `styles.css`, не закоммичено).
Seed добыт экспортом из Google Authenticator (см. §3.1). Осталось: вставить seed в панель,
сверить кнопкой «Код» с телефоном, включить галочку и сделать один боевой прогон (§3.3–3.4).
Файл остаётся как описание фичи и инструкция по эксплуатации.

---

## 1. Зачем

Сейчас авто-режим доходит до модалки 2FA и встаёт: нужен человек, который пришлёт 6 цифр
в Telegram (`wait2FA`). Это единственное место, где цепочка «увидел конкурента → поменял цену»
не замкнута сама на себя.

Идея: хранить TOTP-seed локально и генерировать те же 6 цифр прямо в расширении
(RFC 6238, `crypto.subtle`, без библиотек и без сети). Тогда цикл закрывается полностью.

**Чего делать НЕЛЬЗЯ** (проверено, чтобы не возвращаться к вопросу): прочитать код из
расширения Authenticator или из другого менеджера паролей нельзя — расширения изолированы,
чужой `chrome.storage` недоступен, `externally_connectable` Authenticator не объявляет.
Либо свой seed, либо native messaging к локальному хелперу (`oathtool`, `keepassxc-cli`).

## 2. Выбранный режим: «сразу и молча»

Из трёх вариантов (пауза-окно на перехват / сразу / только по `ok` из Telegram)
владелец выбрал **сразу**: как только появилась модалка 2FA — генерим код, вставляем, жмём
Submit. В Telegram уходит только факт: `✅ Обновлено: 42 THB`.

Следствие: перехватить цену между «Готово» и сохранением нельзя. Менять — постфактум
через `/change <цена>`. Это осознанный выбор, не недоработка.

## 3. Шаги владельца (делать до того, как Claude вернёт код)

### 3.1. Достать seed — главный блокер

Нужна строка base32 (`JBSWY3DPEHPK3PXP`, обычно 16–32 символа) или ссылка
`otpauth://totp/...?secret=...`. Варианты по убыванию удобства:

1. **Сохранял при подключении 2FA** — просто взять.
2. **Лежит в менеджере паролей** (1Password / KeePassXC / Bitwarden) — скопировать оттуда
   `otpauth://`-ссылку, расширение её понимает.
3. **Лежит в расширении Authenticator (authenticator.cc)** — у него есть собственный
   экспорт/бэкап: настройки (шестерёнка) → Backup / Export → выгрузка с `otpauth://`-ссылками
   или JSON, где у каждой записи есть `secret`. Если ставился пароль на хранилище — сначала
   разблокировать. Биржу трогать не нужно.
4. **Лежит в Google Authenticator на телефоне** ← текущий случай. У приложения есть
   «Перенос аккаунтов → Экспорт аккаунтов»: выбрать **только BingX**, получить QR вида
   `otpauth-migration://offline?data=<base64>` (внутри protobuf с seed'ами), снять скриншот,
   перекинуть на мак и расшифровать локально:

   ```
   python3 tools/decode-ga-export.py ~/Downloads/qr.png
   ```

   Скрипт офлайновый, без зависимостей: protobuf разбирает сам, QR читает штатной macOS
   Vision через `tools/qr-decode.swift` (первый запуск до минуты — swift компилирует скрипт).
   Онлайн-декодеры **не использовать** — это отдача всех seed'ов сразу.
   Нюансы: на Android экран экспорта в части версий блокирует скриншот — тогда сфотографировать
   другим устройством; скриншот после расшифровки удалить (и очистить корзину).
   Биржу трогать не нужно.
5. **Нигде нет** — переподключить 2FA в настройках безопасности BingX: отключить, включить
   заново, на шаге с QR нажать «не могу отсканировать / ввести ключ вручную» — показанная
   строка и есть seed. Записать в надёжное место.

> ⚠ Только для варианта 5: перед переподключением проверить, не вешает ли BingX блокировку
> вывода на 24–48 часов после смены 2FA. Варианты 1–4 биржи не касаются вообще.

### 3.2. Проверить часы на маке

`Системные настройки → Основные → Дата и время → Устанавливать автоматически`.
TOTP завязан на время; расхождение часов — причина №1 для «код не принят» при верном seed.

### 3.3. Ввести и сверить (после возврата кода)

1. Включить «Автоном» → появится строка с полем **Seed** и кнопкой **«Код»**.
2. Вставить seed, нажать «Код» → панель покажет `123456 (17 с)`.
3. Сверить с приложением на телефоне. **Совпало — seed верный**, можно ставить галочку
   «Авто-2FA». Не совпало — галочку не ставить, разбираться (часы? не тот seed?).
4. Это проверка без единой операции на бирже.

### 3.4. Один боевой прогон

Сказать боту `/change <цена близкая к текущей>` и посмотреть всю цепочку. Если сломается —
сработает откат на ручной ввод, ничего не теряется.

## 4. Шаги реализации (Claude)

Все изменения — только в `content.js`. Новых разрешений в `manifest.json` не нужно
(`crypto.subtle` доступен в content script на https-странице).

1. **Общие селекторы 2FA.** Перед `const P2P_MAIN_URL` добавить `TWOFA_SEL`
   (`modal: '.security-verify-entry'`, `input: '.tl-input-inner'`, `submit: '.submit-btn'`)
   и заменить литералы в `runEditPageFlow` и в локальных константах `wait2FA` — чтобы
   селекторы не разъезжались между двумя путями.
2. **Секция TOTP** — перед `// ===== Edit page flow =====`. Готовый код в §5.
3. **Интеграция** в `runEditPageFlow` сразу после `waitForSelector(TWOFA_SEL.modal, ...)`
   и `renderAutoOverlayWith2FAInfo(...)`. Код в §6. Ручной путь (TG-промпт + `wait2FA`
   + ветки `retarget`/`cancel`/`timeout`) целиком заворачивается в `if (!twofaDone) { ... }`,
   не трогая его содержимое, с переотступом на 4 пробела.
4. **Панель:** строка `totp-row` (чекбокс `autoTotp`, password-поле `totpSecret`,
   кнопка `testTotp`, `span#totpStatus`), видимая при включённом «Автоном» — по аналогии
   с `telegramRow`/`notAtHome`. Плюс: загрузка значений из storage, обработчики,
   очистка в «Сброс». Код в §7.
5. **`/status`** в Telegram: строка `Авто-2FA: вкл/выкл`.
6. **Косметика (сделано):** `.totp-row` в `styles.css` — янтарная полоса по образцу
   голубой `.telegram-row`, код в `#totpStatus` моноширинным.

Ключи storage: `totpSecret` (строка), `autoTotp` (bool).

## 5. Ядро TOTP (готовый код; алгоритм проверен на векторах RFC 6238 в node, §9)

```js
// ===== TOTP (авто-2FA) =====
// Seed хранится локально в chrome.storage.local и никуда не уходит: ни в страницу, ни в Telegram.
function base32Decode(input) {
    const clean = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
    if (!clean) throw new Error('Пустой seed');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx === -1) throw new Error(`Недопустимый символ в seed: "${ch}"`);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    if (!out.length) throw new Error('Seed слишком короткий');
    return new Uint8Array(out);
}

// Принимает и голый base32, и ссылку otpauth://totp/...?secret=...&digits=6&period=30
function parseTotpSecret(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('Seed не задан');
    if (/^otpauth:\/\//i.test(text)) {
        const url = new URL(text);
        const secret = url.searchParams.get('secret');
        if (!secret) throw new Error('В otpauth-ссылке нет secret');
        return {
            secret,
            digits: Number(url.searchParams.get('digits')) || 6,
            period: Number(url.searchParams.get('period')) || 30,
            algorithm: (url.searchParams.get('algorithm') || 'SHA1').toUpperCase().replace(/^SHA/, 'SHA-')
        };
    }
    return { secret: text, digits: 6, period: 30, algorithm: 'SHA-1' };
}

function totpSecondsLeft(period) {
    const p = period || 30;
    return p - Math.floor(Date.now() / 1000) % p;
}

// RFC 6238 на WebCrypto: HMAC от номера 30-секундного окна, динамическая обрезка.
async function generateTotp(cfg, atMs) {
    const { secret, digits = 6, period = 30, algorithm = 'SHA-1' } = cfg;
    const key = await crypto.subtle.importKey(
        'raw', base32Decode(secret), { name: 'HMAC', hash: algorithm }, false, ['sign']
    );
    const counter = Math.floor((atMs || Date.now()) / 1000 / period);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, Math.floor(counter / 2 ** 32));
    view.setUint32(4, counter >>> 0);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
    const offset = sig[sig.length - 1] & 0x0f;
    const num = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
    return String(num % 10 ** digits).padStart(digits, '0');
}

async function getTotpConfig() {
    const d = await getStorage(['totpSecret', 'autoTotp']);
    if (!d.autoTotp || !d.totpSecret) return { enabled: false };
    try {
        return { enabled: true, ...parseTotpSecret(d.totpSecret) };
    } catch (e) {
        return { enabled: false, error: e.message || String(e) };
    }
}

// Вводим свой код в модалку и жмём Submit. Две попытки: если не приняли на границе
// 30-секундного окна, ждём следующее и пробуем свежий код.
async function runAutoTotp(cfg, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
        try {
            const left = totpSecondsLeft(cfg.period);
            if (left < 3) await sleep((left + 0.5) * 1000); // не отправлять код, который вот-вот истечёт

            const code = await generateTotp(cfg);
            const input = await waitForSelector(TWOFA_SEL.input, 3000);
            await setInputValueVue(input, '');
            await sleep(100);
            const log = await setInputValueVue(input, code);
            await sleep(300);
            if (input.value.replace(/\s/g, '') !== code) {
                return { ok: false, reason: `код не вставился в поле: "${input.value}" (${log.join(' | ')})` };
            }

            const submitBtn = await waitForSelector(TWOFA_SEL.submit, 3000);
            submitBtn.click();
            await waitForSelectorGone(TWOFA_SEL.modal, 10000);
            return { ok: true };
        } catch (e) {
            console.warn(`[bingx-monitor] auto-2FA попытка ${i + 1}:`, e.message || e);
            if (!document.querySelector(TWOFA_SEL.modal)) return { ok: true }; // всё-таки прошло
            if (i + 1 >= attempts) return { ok: false, reason: e.message || String(e) };
            await sleep(Math.min(31000, (totpSecondsLeft(cfg.period) + 1) * 1000));
        }
    }
    return { ok: false, reason: 'код не принят' };
}
```

## 6. Интеграция в `runEditPageFlow`

Вставляется сразу после `const tgCfg = await tgGetConfig();`, перед блоком
`if (tgCfg.enabled) { const lines = ['⏸ Дошёл до 2FA.']; ... }`:

```js
        // Авто-2FA: код генерим сами из seed — ни телефона, ни переписки.
        const totpCfg = await getTotpConfig();
        let twofaDone = false;
        if (totpCfg.error) {
            console.error('[bingx-monitor] seed 2FA не разобран:', totpCfg.error);
            if (tgCfg.enabled) await tgSend(`⚠ Авто-2FA выключена: seed не разобран (${totpCfg.error}).`).catch(() => {});
        }
        if (totpCfg.enabled) {
            updateAutoOverlayStatus('Авто-2FA: ввожу код...');
            const res = await runAutoTotp(totpCfg);
            if (res.ok) {
                twofaDone = true;
            } else {
                console.warn('[bingx-monitor] auto-2FA failed:', res.reason);
                updateAutoOverlayStatus(`Авто-2FA не прошла: ${res.reason}. Жду код вручную.`);
                playBeep();
                if (tgCfg.enabled) {
                    await tgSend(`⚠ Авто-2FA не прошла: ${res.reason}\nПроверь seed и часы. Жду код вручную.`).catch(() => {});
                }
            }
        }

        if (!twofaDone) {
            // ...весь существующий ручной путь: TG-промпт, wait2FA, retarget/cancel/timeout...
        }

        await setStorage({ userPrice: target });   // дальше как сейчас
```

## 7. Панель

```html
      <div class="row totp-row" id="totpRow" style="display:none;">
        <label class="autonomous-label"><input type="checkbox" id="autoTotp"> Авто-2FA</label>
        <label>Seed (base32):</label>
        <input type="password" id="totpSecret" placeholder="JBSWY3DP... или otpauth://">
        <button id="testTotp">Код</button>
        <span id="totpStatus"></span>
      </div>
```

Обработчики: `autoTotp` → `chrome.storage.local.set({ autoTotp })`; `totpSecret` → валидация
через `parseTotpSecret` (ошибка пишется в `#totpStatus`, в storage кладём только разобранный);
кнопка `testTotp` → `generateTotp` + `totpSecondsLeft`, показать `123456 (17 с)` для сверки
с телефоном. Показ строки — вместе с `autonomousMode`, очистка — в «Сброс».

## 8. Поведение при сбоях (так и задумано)

| Что случилось | Что делает расширение |
|---|---|
| Код принят | Цена сохранена, возврат на главную, в TG `✅ Обновлено: X THB` |
| Код не принят (часы/seed) | Вторая попытка свежим кодом в следующем окне |
| Обе попытки мимо | Бип, оверлей, в TG `⚠ Авто-2FA не прошла: ...`, дальше **текущий ручной путь** (6 цифр / своя цена / `/cancel`) |
| Seed не парсится | Авто-2FA выключена, предупреждение в TG, сразу ручной путь |
| Галочка снята / seed пуст | Поведение ровно как сегодня |

Хуже, чем сейчас, стать не может: авто-2FA — надстройка над существующим путём, а не замена.

## 9. Тест-план

- **Без биржи:** кнопка «Код» в панели против приложения на телефоне — проверяет seed,
  часы и всю арифметику TOTP разом.
- **Юнит (уже прогнано, см. §5):** `generateTotp` на test vectors RFC 6238 —
  seed `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` (= ASCII `12345678901234567890`), SHA-1, 6 цифр:
  t=59 → `287082`, t=1111111109 → `081804`, t=1234567890 → `005924`,
  t=2000000000 → `279037`, t=20000000000 → `353130` (последний проверяет старшее слово
  64-битного счётчика). Время фиксируется вторым аргументом `atMs`.
- **Боевой:** `/change <цена рядом с текущей>` → смотреть оверлей и сообщения в TG.
- **Проверка отката:** временно испортить seed (лишний символ) → убедиться, что падаем
  в ручной путь, а не в `aborted`.

## 10. Риски и открытые вопросы

- **Seed рядом с сессией.** `chrome.storage.local` — незашифрованный LevelDB в профиле
  Chrome (`~/Library/Application Support/Google/Chrome/<Profile>/Local Extension Settings/<id>/`).
  Кто его прочитает — прочитает и куки залогиненной сессии BingX, так что новой точки отказа
  не добавляется; но это уже не «второй фактор», а второй пароль в том же месте.
  Осознанный размен ради автономности. Альтернатива, если передумаем: native messaging
  к локальному хелперу, seed в зашифрованном vault.
- **Seed не должен утечь в страницу и в Telegram** — в код вшито: в DOM уходит только
  6-значный код (как и сейчас при ручном вводе), в TG — ничего из этого.
- **Не хардкодить seed в `content.js`** (репозиторий), только storage.
- **Поле кода `.tl-input-inner`** — если BingX сделает 6 отдельных ячеек вместо одного input,
  сломается и авто-, и ручной путь одинаково. Чинить в одном месте (`TWOFA_SEL`).
- **Не проверено в браузере:** арифметика TOTP прогнана на векторах RFC 6238, но вставка
  кода в модалку BingX и клик Submit живьём не тестировались — код писался и откатывался
  в одном заходе.
