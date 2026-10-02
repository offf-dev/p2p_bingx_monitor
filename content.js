// ===== Module state =====
let monitoringIntervalId = null;
let audioCtx = null;
let lastBeepedMinPrice = null;
let lastPriceBelowBeepAt = 0;
let missingRowCount = 0;
let autoOverlayEl = null;
let autoFlowRunning = false;
let alertPanelShown = false;
let alertPanelDismissed = false;
let tgMainPollCtx = null; // { aborted: bool }

// ===== Constants =====
const PRICE_BELOW_BEEP_INTERVAL_MS = 30000;
const MIN_TICK = 0.005;
const SANITY_MAX_PCT = 0.20;
const ELEMENT_TIMEOUT_MS = 15000;
const MODAL_APPEAR_TIMEOUT_MS = 10000;
const TWOFA_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 2000;

// ===== Селекторы таблицы объявлений =====
// BingX регулярно меняет утилитарные классы размера (line-heightNN / fontNN), поэтому в селекторы
// берём только смысловые классы. Так в сентябре 2026 отвалилась цена:
// `number line-height20 text1 weight-bolder font18` → `number line-height24 text1 weight-bolder font24`.
const SEL_ROWS = '.p2p-adverts-table .row-item';
const SEL_NAME = '.cursor-pointer.ellipsis.weight-bolder';
const SEL_PRICE = '.number.text1.weight-bolder';
const SEL_LIMIT = '.flex.column-direction.text1.number > span:first-child';
const SEL_LIMIT_RANGE = '.flex.column-direction.text1.number .p2p-calc-formula';
const PRICE_TEXT_RE = /^[\d,]+(?:\.\d+)?\s*THB$/;

// Модалка 2FA (появляется после "Готово"). Успех = модалка исчезла из DOM.
const TWOFA_SEL = {
    modal: '.security-verify-entry',
    input: '.tl-input-inner',
    submit: '.submit-btn'
};

const P2P_MAIN_URL = 'https://fiat.bingx.com/ru-ru/p2p';
const EDIT_URL_BASE = 'https://fiat.bingx.com/ru-ru/p2p/advert/edit';

// ===== Utilities =====
function removeEmojis(text) {
    return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{200D}\u{FE0F}]/gu, '').trim();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getStorage(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(data) {
    return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

async function setAutoState(patch) {
    const { autoUpdate } = await getStorage(['autoUpdate']);
    const updated = { ...(autoUpdate || {}), ...patch };
    await setStorage({ autoUpdate: updated });
    return updated;
}

async function resetAutoState() {
    await setStorage({ autoUpdate: { state: 'idle' } });
}

function getOrderNoFromUrl(url) {
    try {
        return new URL(url).searchParams.get('orderNo');
    } catch (e) {
        return null;
    }
}

function isOnEditPage() {
    return location.pathname.includes('/p2p/advert/edit');
}

function isOnMainPage() {
    return /\/p2p\/?$/.test(location.pathname);
}

function showMessage(message) {
    const el = document.getElementById('alertMessages');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('fade-out');
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => {
            el.textContent = '';
            el.classList.remove('fade-out');
        }, 500);
    }, 5000);
}

function ensureAudioContext() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.error('AudioContext:', e);
            return null;
        }
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(err => console.error('Resume:', err));
    }
    return audioCtx;
}

function playBeep() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
        console.error('playBeep:', e);
    }
}

// ===== DOM helpers =====
async function waitForSelector(selector, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const el = document.querySelector(selector);
        if (el && el.offsetParent !== null) return el;
        await sleep(200);
    }
    throw new Error(`Не найден: ${selector}`);
}

async function waitForSelectorGone(selector, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!document.querySelector(selector)) return;
        await sleep(300);
    }
    throw new Error(`Элемент не исчез: ${selector}`);
}

async function waitForButtonByText(textOrTexts, timeoutMs) {
    const targets = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const t = (btn.textContent || '').trim();
            if (targets.includes(t) && !btn.disabled && btn.offsetParent !== null) {
                return btn;
            }
        }
        await sleep(200);
    }
    throw new Error(`Не найдена кнопка: ${targets.join(' / ')}`);
}

async function setInputValueVue(input, value) {
    const valueStr = String(value);
    const log = [];

    input.click();
    input.focus();
    await sleep(80);
    log.push(`focus=${document.activeElement === input}`);
    log.push(`ph="${input.placeholder || ''}"`);
    log.push(`connected=${input.isConnected}`);

    // Стратегия 1: select() + execCommand('insertText')
    try { input.select(); } catch (e) { /* ignore */ }
    await sleep(20);
    let ok1 = false;
    try { ok1 = document.execCommand('insertText', false, valueStr); } catch (e) { /* ignore */ }
    await sleep(120);
    log.push(`execCmd(${ok1})="${input.value}"`);
    if (input.value === valueStr) return log;

    // Стратегия 2: native setter + InputEvent/change
    input.focus();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, valueStr);
    else input.value = valueStr;
    let evType = 'Event';
    try {
        input.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: true, data: valueStr, inputType: 'insertReplacementText'
        }));
        evType = 'InputEvent';
    } catch (e) {
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await sleep(120);
    log.push(`setter+${evType}="${input.value}"`);
    if (input.value === valueStr) return log;

    // Стратегия 3: посимвольно через execCommand('delete'+'insertText')
    input.focus();
    try { input.select(); } catch (e) { /* ignore */ }
    try { document.execCommand('delete', false); } catch (e) { /* ignore */ }
    await sleep(40);
    for (const ch of valueStr) {
        try { document.execCommand('insertText', false, ch); } catch (e) { /* ignore */ }
        await sleep(20);
    }
    await sleep(120);
    log.push(`charByChar="${input.value}"`);
    return log;
}

// Возвращает наибольшее число с 2 знаками после точки, строго меньшее конкурента.
// 36.645 → 36.64, 36.64 → 36.63, 36.619 → 36.61.
// BingX THB-пара редактируется ровно с точностью 2, поэтому 3-знаковое значение Vue отбрасывает.
function computeSuggestedPrice(competitorPriceStr) {
    const price = parseFloat(competitorPriceStr);
    if (isNaN(price)) return null;
    return Math.floor((price - 1e-6) * 100) / 100;
}

// Точность поля ввода на edit-странице (по placeholder типа "25.81 ~ 41.94").
function getInputPrecision(input) {
    const ph = input && input.placeholder ? input.placeholder : '';
    const m = ph.match(/\d+\.(\d+)/);
    return m ? m[1].length : 2;
}

// На шаге 1 цена — это единственное видимое поле с правым лейблом "THB" И placeholder-диапазоном типа "X ~ Y".
// Другие инпуты формы (Сумма, Лимит) имеют либо лейбл USDT, либо placeholder без "~".
async function waitForPriceInput(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const inputs = Array.from(document.querySelectorAll('input.fiat-input.number'))
            .filter(el => el.offsetParent !== null);
        for (const el of inputs) {
            const wrap = el.closest('.fiat-input-wrap');
            const rightLabel = wrap ? wrap.querySelector('.input-right span') : null;
            const labelText = rightLabel ? rightLabel.textContent.trim() : '';
            const ph = el.placeholder || '';
            if (labelText === 'THB' && ph.includes('~')) {
                return el;
            }
        }
        await sleep(200);
    }
    throw new Error('Не найден input цены (THB-поле с диапазоном в placeholder)');
}

// ===== Telegram =====
async function tgGetConfig() {
    const d = await getStorage(['telegramToken', 'telegramChatId', 'notAtHome', 'autonomousMode']);
    const enabled = !!(d.notAtHome && d.autonomousMode && d.telegramToken && d.telegramChatId);
    return { token: d.telegramToken, chatId: d.telegramChatId, enabled };
}

async function tgSend(text, opts) {
    const { token, chatId, enabled } = await tgGetConfig();
    if (!enabled) return false;
    const html = !!(opts && opts.html);
    const post = (body) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => r.json());
    try {
        const base = { chat_id: chatId, text, disable_web_page_preview: true };
        let json = await post(html ? { ...base, parse_mode: 'HTML' } : base);
        if (!json.ok && html) {
            // Кривая разметка не должна съедать сообщение целиком — шлём как есть, без тегов.
            console.warn('TG HTML parse failed, retry plain:', json);
            json = await post({ ...base, text: stripHtml(text) });
        }
        if (!json.ok) console.warn('TG sendMessage not ok:', json);
        return json.ok;
    } catch (e) {
        console.error('TG send:', e);
        return false;
    }
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(text) {
    return String(text)
        .replace(/<\/?pre>\n?/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Принудительная отправка с конкретным конфигом (для кнопки "Тест").
async function tgSendWith(token, chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
    });
    return res.json();
}

// Long-poll Telegram для сообщений от нашего chat. timeoutSec — параметр Telegram long-poll (до 50 сек).
async function tgPollUpdates(token, offset, timeoutSec) {
    const offsetInt = Number.isInteger(offset) ? offset : 0;
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offsetInt}&timeout=${timeoutSec}`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) {
        const err = new Error('TG getUpdates: ' + JSON.stringify(json));
        err.errorCode = json.error_code;
        err.description = json.description || '';
        throw err;
    }
    return json.result;
}

// Если бот был настроен на webhook, getUpdates не работает. Снимаем webhook.
async function tgDeleteWebhook(token) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' });
        const json = await res.json();
        console.log('[bingx-monitor] deleteWebhook:', json);
        return json.ok;
    } catch (e) {
        console.error('deleteWebhook failed:', e);
        return false;
    }
}

// ===== Auto overlay (on edit page during flow) =====
function ensureAutoOverlay() {
    if (!autoOverlayEl || !document.body.contains(autoOverlayEl)) {
        autoOverlayEl = document.createElement('div');
        autoOverlayEl.id = 'bingx-auto-overlay';
        document.body.appendChild(autoOverlayEl);
    }
    return autoOverlayEl;
}

function renderAutoOverlay(statusText, { showCancel = true, isError = false } = {}) {
    const el = ensureAutoOverlay();
    el.classList.toggle('error', isError);
    el.innerHTML = `
        <div class="bingx-auto-title">Изменение цены объявления</div>
        <div class="bingx-auto-status"></div>
        ${showCancel ? '<button id="bingx-auto-cancel">Отменить</button>' : ''}
    `;
    el.querySelector('.bingx-auto-status').textContent = statusText;
    if (showCancel) {
        el.querySelector('#bingx-auto-cancel').addEventListener('click', onCancelAutoUpdate);
    }
}

function updateAutoOverlayStatus(statusText, isError = false) {
    if (!autoOverlayEl) {
        renderAutoOverlay(statusText, { isError });
        return;
    }
    autoOverlayEl.classList.toggle('error', isError);
    const s = autoOverlayEl.querySelector('.bingx-auto-status');
    if (s) s.textContent = statusText;
}

function hideAutoOverlay() {
    if (autoOverlayEl) {
        autoOverlayEl.remove();
        autoOverlayEl = null;
    }
}

function renderAutoOverlayWith2FAInfo({ status, competitor, oldPrice, target }) {
    const el = ensureAutoOverlay();
    el.classList.remove('error');
    const infoLines = [];
    if (competitor != null) infoLines.push(`Конкурент: <b>${competitor}</b> THB`);
    if (oldPrice != null) infoLines.push(`Ваша была: <b>${oldPrice}</b> THB`);
    if (target != null) infoLines.push(`Новая: <b>${target}</b> THB`);
    const infoHtml = infoLines.length
        ? `<div class="bingx-auto-info">${infoLines.join('<br>')}</div>`
        : '';
    el.innerHTML = `
        <div class="bingx-auto-title">Изменение цены объявления</div>
        ${infoHtml}
        <div class="bingx-auto-status"></div>
        <button id="bingx-auto-cancel">Отменить</button>
    `;
    el.querySelector('.bingx-auto-status').textContent = status;
    el.querySelector('#bingx-auto-cancel').addEventListener('click', onCancelAutoUpdate);
}

async function onCancelAutoUpdate() {
    autoFlowRunning = false;
    await setStorage({ autoUpdate: { state: 'idle' } });
    hideAutoOverlay();
    if (!isOnMainPage()) {
        window.location.href = P2P_MAIN_URL;
    }
}

// ===== Alert sub-panel (on main page when beaten) =====
// suggestedTarget: предложенная цена; label: текст-заголовок над панелью; null = не подставлять.
function showAlertPanel({ suggestedTarget, label }) {
    if (alertPanelDismissed) return;
    const el = document.getElementById('alertSubPanel');
    if (!el) return;
    if (label) {
        const labelEl = el.querySelector('.alert-label');
        if (labelEl) labelEl.textContent = label;
    }
    if (!alertPanelShown) {
        const newPriceEl = document.getElementById('newPrice');
        if (newPriceEl && !newPriceEl.value && suggestedTarget != null) newPriceEl.value = suggestedTarget;
        chrome.storage.local.get(['lastOrderNo'], (data) => {
            const noEl = document.getElementById('newOrderNo');
            if (noEl && !noEl.value && data.lastOrderNo) noEl.value = data.lastOrderNo;
        });
        alertPanelShown = true;
    }
    el.style.display = 'flex';
}

function hideAlertPanel() {
    const el = document.getElementById('alertSubPanel');
    if (el) el.style.display = 'none';
    alertPanelShown = false;
}

async function onApplyPriceChange() {
    const newPrice = parseFloat(document.getElementById('newPrice').value);
    const orderNo = (document.getElementById('newOrderNo').value || '').trim();
    const errEl = document.getElementById('alertError');

    if (!newPrice || isNaN(newPrice) || newPrice <= 0) {
        errEl.textContent = 'Введите корректную цену!';
        return;
    }
    if (!orderNo) {
        errEl.textContent = 'Введите orderNo!';
        return;
    }
    errEl.textContent = '';

    await setStorage({ lastOrderNo: orderNo });

    const { userPrice: oldPrice } = await getStorage(['userPrice']);

    stopMonitoring();
    await setStorage({
        autoUpdate: {
            state: 'goto_edit',
            target: newPrice,
            orderNo,
            competitor: lastBeepedMinPrice,
            oldPrice,
            startedAt: Date.now()
        }
    });

    hideAlertPanel();
    alertPanelDismissed = true;
    showMessage(`Переход на редактирование (${newPrice} THB)...`);
    await sleep(300);
    window.location.href = `${EDIT_URL_BASE}?orderNo=${encodeURIComponent(orderNo)}`;
}

// Универсальный триггер авто-редактирования. target — итоговая цена; refPrice — конкурент-якорь
// (для записи в state и сообщений); shortMsg/tgMsg — описание причины.
async function triggerAutonomousEdit({ target, refPrice, oldPrice, orderNo, shortMsg, tgMsg, tgHtml }) {
    const { autoUpdate } = await getStorage(['autoUpdate']);
    if (autoUpdate && autoUpdate.state && autoUpdate.state !== 'idle') return;

    if (target === null || isNaN(target) || target <= 0) {
        showMessage('Автоном: не удалось вычислить новую цену.');
        return;
    }

    stopMonitoring();
    await setStorage({
        autoUpdate: {
            state: 'goto_edit',
            target,
            orderNo,
            competitor: refPrice,
            oldPrice,
            startedAt: Date.now()
        }
    });
    showMessage(shortMsg || `Автоном: ${oldPrice} → ${target}. Переход...`);
    if (tgMsg) tgSend(tgMsg, { html: !!tgHtml }).catch(() => {});
    await sleep(300);
    window.location.href = `${EDIT_URL_BASE}?orderNo=${encodeURIComponent(orderNo)}`;
}

// ===== Core monitoring =====
// Цена: сначала по классам, затем фолбэк по формату текста ("36.25 THB" одним узлом без детей).
// Диапазон лимита ("500.00 THB - 7,250.00 THB") под регулярку не подходит и не перехватывается.
function findPriceEl(row) {
    const byClass = row.querySelector(SEL_PRICE);
    if (byClass) return byClass;
    return Array.from(row.querySelectorAll('td div, td span'))
        .find(el => !el.children.length && PRICE_TEXT_RE.test(el.textContent.trim())) || null;
}

// Снимок всей таблицы объявлений: имя / цена / доступный объём / лимиты по каждому ряду.
// cleanInputName и ignored — уже очищенные от эмодзи имена, чтобы проставить флаги isOwn/ignored.
function collectMerchantRows(cleanInputName, ignored) {
    const ignoredList = ignored || [];
    const out = [];
    document.querySelectorAll(SEL_ROWS).forEach((row) => {
        const nameEl = row.querySelector(SEL_NAME);
        const priceEl = findPriceEl(row);
        const limitEl = row.querySelector(SEL_LIMIT);
        const rangeEl = row.querySelector(SEL_LIMIT_RANGE);

        const name = nameEl ? removeEmojis(nameEl.textContent.trim()) : '';
        let price = null, priceStr = null;
        if (priceEl) {
            priceStr = priceEl.textContent.replace(' THB', '').replace(/,/g, '').trim();
            const parsed = parseFloat(priceStr);
            price = isNaN(parsed) ? null : parsed;
            if (price === null) priceStr = null;
        }
        let available = null;
        const availableStr = limitEl ? limitEl.textContent.replace(/\s+/g, ' ').trim() : '';
        if (limitEl) {
            const parsed = parseFloat(availableStr.replace(' USDT', '').replace(/,/g, '').trim());
            if (!isNaN(parsed)) available = parsed;
        }
        const range = rangeEl ? rangeEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const rangeNums = (range.match(/[\d][\d,]*(?:\.\d+)?/g) || [])
            .map(n => parseFloat(n.replace(/,/g, '')))
            .filter(n => !isNaN(n));
        out.push({
            name,
            price,
            priceStr,
            available,
            availableStr,
            hasLimit: !!limitEl,
            range,
            rangeMin: rangeNums.length > 1 ? rangeNums[0] : null,
            rangeMax: rangeNums.length > 1 ? rangeNums[1] : null,
            isOwn: !!cleanInputName && name.includes(cleanInputName),
            ignored: ignoredList.includes(name)
        });
    });
    return out;
}

// 3000 → 3k, 16874 → 17k, 460.8 → 461, 20.52 → 20.5 — чтобы колонки не расползались.
function fmtAmountShort(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n >= 100) return String(Math.round(n));
    return n.toFixed(1).replace(/\.0$/, '');
}

// Выравнивание цен по десятичной точке: "36.62" при maxFrac=3 → "36.62 ".
function padPriceCell(priceStr, maxFrac) {
    const dot = priceStr.indexOf('.');
    const frac = dot === -1 ? 0 : priceStr.length - dot - 1;
    return priceStr + (dot === -1 && maxFrac > 0 ? ' ' : '') + ' '.repeat(maxFrac - frac);
}

function truncName(name, max) {
    if (!name) return '—';
    return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

// Стакан для Telegram: моноширинная таблица в <pre> (отправлять с { html: true }).
// Колонки: цена | доступно USDT | лимиты THB | торговец. Свой ряд — «▶», игнор — «×».
function formatMerchantsSummary(rows, opts) {
    const { userPrice, priceFloor, priceCeil, max = 12 } = opts || {};
    const listed = rows.filter(r => r.price !== null).sort((a, b) => a.price - b.price);
    if (!listed.length) return '';

    const entries = listed.slice(0, max).map(r => ({
        price: r.price,
        priceStr: r.priceStr,
        vol: fmtAmountShort(r.available),
        lim: (r.rangeMin !== null && r.rangeMax !== null)
            ? `${fmtAmountShort(r.rangeMin)}-${fmtAmountShort(r.rangeMax)}`
            : '—',
        name: truncName(r.name, 12),
        mark: r.isOwn ? '▶' : (r.ignored ? '×' : ' ')
    }));

    // Своего ряда в таблице нет (имя мерчанта не задано) — ставим ориентир по цене из панели.
    const hasOwn = entries.some(e => e.mark === '▶');
    if (userPrice && !hasOwn) {
        const at = entries.findIndex(e => e.price > userPrice);
        entries.splice(at === -1 ? entries.length : at, 0, {
            price: userPrice, priceStr: String(userPrice), vol: '—', lim: '—', name: 'вы', mark: '▶'
        });
    }

    const maxFrac = entries.reduce((m, e) => {
        const dot = e.priceStr.indexOf('.');
        return Math.max(m, dot === -1 ? 0 : e.priceStr.length - dot - 1);
    }, 0);
    const cells = entries.map(e => ({ ...e, priceCell: padPriceCell(e.priceStr, maxFrac) }));

    const head = ['цена', 'USDT', 'лимит', 'торговец'];
    const wPrice = Math.max(head[0].length, ...cells.map(c => c.priceCell.length));
    const wVol = Math.max(head[1].length, ...cells.map(c => c.vol.length));
    const wLim = Math.max(head[2].length, ...cells.map(c => c.lim.length));

    const row = (mark, price, vol, lim, name) =>
        mark + price.padEnd(wPrice) + ' ' + vol.padStart(wVol) + ' ' + lim.padEnd(wLim) + ' ' + name;

    const header = row(' ', head[0], head[1], head[2], head[3]);
    const rowLines = cells.map(c => row(c.mark, c.priceCell, c.vol, c.lim, escapeHtml(c.name)));
    const visibleLen = (l) => l.replace(/&[a-z]+;/g, 'x').length;
    const width = Math.max(...[header, ...rowLines].map(visibleLen));

    // Черты предела и потолка рисуем только там, где они реально делят стакан;
    // иначе уровень уходит в подпись, чтобы не занимать строку зря.
    const offTable = [];
    const marks = new Map(); // индекс строки → черта(ы) перед ней
    [[priceFloor, 'предел'], [priceCeil, 'потолок']].forEach(([level, word]) => {
        if (!level) return;
        const at = cells.findIndex(c => c.price > level);
        if (at > 0) {
            const line = levelSeparator(`${word} ${level}`, width);
            marks.set(at, marks.has(at) ? marks.get(at) + '\n' + line : line);
        } else {
            offTable.push(`${word} ${level}`);
        }
    });

    const table = [header];
    rowLines.forEach((line, i) => {
        if (marks.has(i)) table.push(marks.get(i));
        table.push(line);
    });
    const body = table.join('\n');

    const legend = [];
    if (listed.length > entries.length) legend.push(`ещё ${listed.length - entries.length} дороже`);
    legend.push('▶ вы');
    if (cells.some(c => c.mark === '×')) legend.push('× игнор');
    legend.push(...offTable);
    legend.push('лимиты THB');

    return [
        `📋 Стакан (${listed.length}):`,
        '<pre>' + body + '</pre>',
        escapeHtml(legend.join(' · '))
    ].join('\n');
}

function levelSeparator(text, width) {
    const label = ` ${text} `;
    const left = Math.max(2, Math.floor((width - label.length) / 2));
    const right = Math.max(2, width - left - label.length);
    return '─'.repeat(left) + label + '─'.repeat(right);
}

// Своя цена из сообщения TG: "37", "37,5", "/change 36.55", "/price 36.55".
// Шесть цифр подряд сюда не попадают (это код 2FA): целая часть — максимум 4 знака.
function parseTgPrice(rawText) {
    const m = (rawText || '').trim().match(/^(?:\/?(?:change|price|цена)\s*)?(\d{1,4}(?:[.,]\d{1,4})?)$/i);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.'));
    return (isNaN(v) || v <= 0) ? null : v;
}

// Перезапуск формы редактирования с новой целью (та же URL → reload).
function navigateToEdit(orderNo) {
    const url = `${EDIT_URL_BASE}?orderNo=${encodeURIComponent(orderNo)}`;
    if (location.href === url) window.location.reload();
    else window.location.href = url;
}

// Возвращает счётчики по каждому селектору, чтобы при поломке вёрстки было видно, что именно отвалилось.
function checkSelectors() {
    const rows = document.querySelectorAll(SEL_ROWS);
    let price = 0, limit = 0, name = 0;
    rows.forEach((row) => {
        if (findPriceEl(row)) price++;
        if (row.querySelector(SEL_LIMIT)) limit++;
        if (row.querySelector(SEL_NAME)) name++;
    });
    return { ok: rows.length > 0 && price > 0 && limit > 0, counts: { rows: rows.length, price, limit, name } };
}

// Описания режимов для UI/TG: undercut / jumpAboveField / raiseToLeader / loneAboveFloor.
function describeShortMsg(mode, refPrice, oldPrice, target) {
    switch (mode) {
        case 'undercut':
            return refPrice < oldPrice
                ? `Перебили: ${refPrice} < ${oldPrice}. → ${target}.`
                : `Сравнялись с ${refPrice}. → ${target}.`;
        case 'jumpAboveField':
            return `Лидер на пределе. Прыгаю под ${refPrice} → ${target}.`;
        case 'raiseToLeader':
            return `Один в лидерах. Поднимаю под ${refPrice} → ${target}.`;
    }
    return `${oldPrice} → ${target}`;
}

function describeTgMsg(mode, refPrice, oldPrice, target) {
    switch (mode) {
        case 'undercut': {
            const verb = refPrice < oldPrice ? 'Перебили' : 'Сравнялись';
            return `⚠ ${verb}. Конкурент: ${refPrice} THB. Ваша: ${oldPrice} THB. Меняю на ${target} THB.`;
        }
        case 'jumpAboveField':
            return `⤴ Лидер просел до предела. Прыгаю наверх под ${refPrice} THB. Ваша: ${oldPrice} → ${target} THB.`;
        case 'raiseToLeader':
            return `⤴ Один в лидерах с зазором. Поднимаюсь под ${refPrice} THB. Ваша: ${oldPrice} → ${target} THB.`;
    }
    return '';
}

function describeAlertLabel(mode, refPrice) {
    switch (mode) {
        case 'undercut':
            return `Цену перебили (${refPrice}) — изменить:`;
        case 'jumpAboveField':
            return `Лидер на пределе (${refPrice}) — прыжок наверх:`;
        case 'raiseToLeader':
            return `Один в лидерах — поднять под ${refPrice}:`;
    }
    return 'Изменить цену:';
}

function performCycle() {
    chrome.storage.local.get(
        ['userPrice', 'priceFloor', 'priceCeil', 'merchantName', 'ignoredMerchants', 'isMonitoring', 'previousLimit', 'autonomousMode', 'lastOrderNo'],
        (data) => {
            if (!data.isMonitoring) {
                stopMonitoring();
                return;
            }

            const userPrice = data.userPrice;
            const priceFloor = (typeof data.priceFloor === 'number' && data.priceFloor > 0) ? data.priceFloor : null;
            const priceCeilRaw = (typeof data.priceCeil === 'number' && data.priceCeil > 0) ? data.priceCeil : null;
            // Потолок ниже предела — бессмысленная пара, игнорируем потолок (в панели это подсвечено).
            const priceCeil = (priceCeilRaw && priceFloor && priceCeilRaw < priceFloor) ? null : priceCeilRaw;
            const merchantName = data.merchantName;
            const ignoredMerchants = data.ignoredMerchants
                ? data.ignoredMerchants.split(',').map(n => removeEmojis(n.trim())).filter(Boolean)
                : [];

            try {
                const cleanInputName = merchantName ? removeEmojis(merchantName) : '';
                const allRows = collectMerchantRows(cleanInputName, ignoredMerchants);
                const competitors = allRows.filter(r => !r.isOwn && !r.ignored && r.price !== null);
                const ownRow = allRows.find(r => r.isOwn && r.hasLimit) || null;
                const foundOwnRow = !!ownRow;
                const currentLimit = ownRow ? ownRow.available : null;

                competitors.sort((a, b) => a.price - b.price);
                const leader = competitors[0] || null;

                // ===== Decision =====
                let mode = null;
                let target = null;
                let refPrice = null;

                if (userPrice && leader) {
                    if (priceFloor && leader.price <= priceFloor) {
                        // Лидер просел до/ниже предела — паркуемся под наименьшим конкурентом > предела.
                        const aboveFloor = competitors.find(c => c.price > priceFloor);
                        if (aboveFloor) {
                            const candidate = computeSuggestedPrice(aboveFloor.priceStr);
                            if (candidate !== null && candidate >= priceFloor
                                && Math.abs(candidate - userPrice) > 1e-6) {
                                mode = 'jumpAboveField';
                                target = candidate;
                                refPrice = aboveFloor.price;
                            }
                        } else {
                            // Над пределом никого — без авто-действия, только сигнал.
                            mode = 'loneAboveFloor';
                            refPrice = leader.price;
                        }
                    } else {
                        // c1 > предела (или предел не задан).
                        const candidate = computeSuggestedPrice(leader.priceStr);
                        if (candidate !== null && candidate > 0) {
                            if (priceFloor) {
                                // С пределом работаем в обе стороны: undercut и raise.
                                if (Math.abs(candidate - userPrice) > 1e-6) {
                                    mode = candidate < userPrice ? 'undercut' : 'raiseToLeader';
                                    target = candidate;
                                    refPrice = leader.price;
                                }
                            } else {
                                // Без предела — legacy: только undercut, raise отключён.
                                // Свой ряд исключён, поэтому при known merchantName допустимо равенство.
                                const beaten = cleanInputName
                                    ? leader.price <= userPrice
                                    : leader.price < userPrice;
                                if (beaten && Math.abs(candidate - userPrice) > 1e-6) {
                                    mode = 'undercut';
                                    target = candidate;
                                    refPrice = leader.price;
                                }
                            }
                        }
                    }
                }

                // ===== Потолок =====
                // Конкурент на 38 → формула даёт 37.99, но если нам и 37 достаточно —
                // паркуемся на потолке и больше не дёргаемся, пока он не изменится.
                let capped = false;
                if (mode && mode !== 'loneAboveFloor' && target !== null && priceCeil && target > priceCeil) {
                    target = priceCeil;
                    capped = true;
                    if (Math.abs(target - userPrice) <= 1e-6) {
                        // Уже стоим на потолке — менять нечего.
                        mode = null;
                        target = null;
                        refPrice = null;
                    }
                }
                const capNote = capped ? ` (потолок ${priceCeil})` : '';

                // ===== Reaction =====
                if (mode === 'loneAboveFloor') {
                    const now = Date.now();
                    const refChanged = lastBeepedMinPrice !== refPrice;
                    const timeToRemind = now - lastPriceBelowBeepAt >= PRICE_BELOW_BEEP_INTERVAL_MS;
                    if (refChanged || timeToRemind) {
                        playBeep();
                        showMessage(`Лидер на пределе (${refPrice}), выше никого. Введи цену вручную.`);
                        lastBeepedMinPrice = refPrice;
                        lastPriceBelowBeepAt = now;
                        if (data.autonomousMode) {
                            const summary = formatMerchantsSummary(allRows, { userPrice, priceFloor, priceCeil });
                            tgSend([
                                escapeHtml(`⚠ Лидер на пределе ${refPrice} THB, других конкурентов выше нет. Реши: /change <цена>.`),
                                summary
                            ].filter(Boolean).join('\n\n'), { html: true }).catch(() => {});
                        }
                    }
                    showAlertPanel({ suggestedTarget: null, label: `Лидер на пределе (${refPrice}). Введи цену вручную:` });
                } else if (mode) {
                    const now = Date.now();
                    const refChanged = lastBeepedMinPrice !== refPrice;
                    const timeToRemind = now - lastPriceBelowBeepAt >= PRICE_BELOW_BEEP_INTERVAL_MS;
                    if (refChanged || timeToRemind) {
                        playBeep();
                        showMessage(describeShortMsg(mode, refPrice, userPrice, target) + capNote);
                        lastBeepedMinPrice = refPrice;
                        lastPriceBelowBeepAt = now;
                    }

                    if (data.autonomousMode && data.lastOrderNo) {
                        // Сводку по всей таблице шлём там, где цена двигается вверх вслепую:
                        // предложенные 42 могут быть избыточны, когда хватает 37 — решает пользователь.
                        const tgParts = [escapeHtml(describeTgMsg(mode, refPrice, userPrice, target) + capNote)];
                        if (mode === 'jumpAboveField' || mode === 'raiseToLeader' || capped) {
                            tgParts.push(formatMerchantsSummary(allRows, { userPrice, priceFloor, priceCeil }));
                        }
                        tgParts.push(escapeHtml('Не согласен — пришли своё число (напр. 37) вместо кода 2FA, поставлю его.'));
                        triggerAutonomousEdit({
                            target,
                            refPrice,
                            oldPrice: userPrice,
                            orderNo: data.lastOrderNo,
                            shortMsg: describeShortMsg(mode, refPrice, userPrice, target) + capNote + ' Переход...',
                            tgMsg: tgParts.filter(Boolean).join('\n\n'),
                            tgHtml: true
                        }).catch(err => {
                            console.error('Autonomous trigger:', err);
                            showAlertPanel({ suggestedTarget: target, label: describeAlertLabel(mode, refPrice) + capNote });
                        });
                    } else {
                        if (data.autonomousMode && !data.lastOrderNo) {
                            showMessage('Автоном: orderNo не захвачен. Открой edit вручную один раз.');
                        }
                        showAlertPanel({ suggestedTarget: target, label: describeAlertLabel(mode, refPrice) + capNote });
                    }
                } else {
                    lastBeepedMinPrice = null;
                    lastPriceBelowBeepAt = 0;
                    alertPanelDismissed = false;
                    hideAlertPanel();
                }

                const errorEl = document.getElementById('error');
                if (merchantName) {
                    if (foundOwnRow) {
                        missingRowCount = 0;
                        if (errorEl) errorEl.textContent = '';
                        const previousLimit = data.previousLimit;
                        if (currentLimit !== null && typeof previousLimit === 'number' && currentLimit !== previousLimit) {
                            playBeep();
                            showMessage(`Лимит изменился! Новый: ${currentLimit} USDT (предыдущий: ${previousLimit} USDT)`);
                        }
                        if (currentLimit !== null) {
                            chrome.storage.local.set({ previousLimit: currentLimit });
                        }
                    } else {
                        missingRowCount++;
                        if (errorEl) errorEl.textContent = 'Ваш ряд не найден!';
                        if (missingRowCount >= 2 && typeof data.previousLimit === 'number') {
                            playBeep();
                            showMessage('Ваш ряд исчез! USDT выкуплены?');
                            chrome.storage.local.set({ previousLimit: null });
                            missingRowCount = 0;
                        }
                    }
                }
            } catch (e) {
                console.error('performCycle:', e);
            }
        }
    );
}

function startMonitoring() {
    stopMonitoring();
    lastBeepedMinPrice = null;
    lastPriceBelowBeepAt = 0;
    missingRowCount = 0;
    alertPanelDismissed = false;
    performCycle();
    monitoringIntervalId = setInterval(performCycle, 10000);
    startTgMainPoll().catch(e => console.error('TG main poll start:', e));
}

function stopMonitoring() {
    if (monitoringIntervalId) {
        clearInterval(monitoringIntervalId);
        monitoringIntervalId = null;
    }
    hideAlertPanel();
    stopTgMainPoll();
}

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

// ===== Edit page flow =====
async function runEditPageFlow(params) {
    if (autoFlowRunning) return;
    autoFlowRunning = true;

    const { competitor, oldPrice } = params;
    const orderNo = params.orderNo || getOrderNoFromUrl(location.href);
    let { target } = params;

    try {
        renderAutoOverlay('Жду поле цены...');
        let priceInput = await waitForPriceInput(ELEMENT_TIMEOUT_MS);

        // Если у target больше знаков, чем допускает поле BingX — floor к допустимой точности.
        // Для уже "чистых" значений (2 знака) ничего не делаем, иначе float-арифметика
        // превратит 36.97 в 36.96 из-за представления как 36.9699999...
        const precision = getInputPrecision(priceInput);
        const factor = Math.pow(10, precision);
        const shifted = target * factor;
        if (Math.abs(shifted - Math.round(shifted)) > 1e-6) {
            const floored = Math.floor(shifted) / factor;
            console.log(`[bingx-monitor] target ${target} floor → ${floored} (precision ${precision})`);
            target = floored;
        }

        const currentValue = parseFloat(priceInput.value);
        if (!isNaN(currentValue) && currentValue > 0) {
            const diffPct = Math.abs(target - currentValue) / currentValue;
            if (diffPct > SANITY_MAX_PCT) {
                throw new Error(`Санитарный диапазон: ${currentValue} → ${target} = ${(diffPct * 100).toFixed(1)}% (>${(SANITY_MAX_PCT * 100).toFixed(0)}%). Отмена.`);
            }
        }

        updateAutoOverlayStatus(`Подстановка цены: ${currentValue} → ${target}`);

        // Перезапрашиваем input — Vue мог перерисовать элемент, наш референс может быть stale
        if (!priceInput.isConnected) {
            priceInput = await waitForPriceInput(3000);
        }

        const log = await setInputValueVue(priceInput, String(target));
        console.log('[bingx-monitor] setInputValueVue attempts:', log);
        await sleep(500);

        // Проверка, что Vue принял новое значение (а не откатил на исходное)
        const appliedValue = parseFloat(priceInput.value);
        if (isNaN(appliedValue) || Math.abs(appliedValue - target) > 1e-6) {
            throw new Error(`Ввод не применился: "${priceInput.value}" (нужно ${target}). ${log.join(' | ')}`);
        }

        updateAutoOverlayStatus('Шаг 1/2: клик "Далее"');
        const nextBtn = await waitForButtonByText('Далее', 5000);
        nextBtn.click();
        await sleep(500);

        updateAutoOverlayStatus('Шаг 2/2: клик "Готово"');
        const doneBtn = await waitForButtonByText('Готово', ELEMENT_TIMEOUT_MS);
        doneBtn.click();

        updateAutoOverlayStatus('Жду окно 2FA...');
        await waitForSelector(TWOFA_SEL.modal, MODAL_APPEAR_TIMEOUT_MS);

        renderAutoOverlayWith2FAInfo({
            status: 'Введите код Google Authenticator. Мониторинг возобновится автоматически после успеха.',
            competitor, oldPrice, target
        });

        const tgCfg = await tgGetConfig();

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
            if (tgCfg.enabled) {
                const lines = ['⏸ Дошёл до 2FA.'];
                if (competitor != null) lines.push(`Конкурент: ${competitor} THB`);
                if (oldPrice != null) lines.push(`Ваша: ${oldPrice} THB`);
                if (target != null) lines.push(`Новая: ${target} THB`);
                lines.push('', 'Пришли 6 цифр 2FA.');
                lines.push('Своя цена вместо предложенной — просто число (напр. 37).');
                lines.push('/cancel — отбой.');
                await tgSend(lines.join('\n'));
            }

            const outcome = await wait2FA(tgCfg, TWOFA_WAIT_TIMEOUT_MS);
            if (outcome.type === 'retarget') {
                // Пользователь прислал свою цену вместо кода — перезапускаем форму с новой целью.
                if (!orderNo) throw new Error('Своя цена принята, но orderNo неизвестен — перезапуск невозможен.');
                if (tgCfg.enabled) {
                    await tgSend(`🔁 Ставлю вашу цену ${outcome.price} THB вместо ${target}. Перезаполняю форму, жду 2FA.`).catch(() => {});
                }
                await setStorage({
                    autoUpdate: {
                        state: 'goto_edit',
                        target: outcome.price,
                        orderNo,
                        competitor,
                        oldPrice,
                        startedAt: Date.now()
                    }
                });
                updateAutoOverlayStatus(`Новая цель: ${outcome.price} THB. Перезапуск формы...`);
                await sleep(500);
                navigateToEdit(orderNo);
                return;
            }
            if (outcome.type === 'cancel') {
                // Soft cancel — цена не сохранена, но возвращаемся на главную и продолжаем мониторинг.
                // Уведомление в TG уже отправлено из wait2FA одним сообщением.
                await setAutoState({ state: 'cooldown' });
                updateAutoOverlayStatus('Отменено. Возврат на главную...');
                await sleep(COOLDOWN_MS);
                window.location.href = P2P_MAIN_URL;
                return;
            }
            if (outcome.type === 'timeout') {
                // Soft recovery: вместо мёртвого аборта возвращаемся на главную, мониторинг + поллинг продолжатся.
                if (tgCfg.enabled) {
                    await tgSend('⏱ Таймаут 2FA. Возвращаюсь на главную, мониторинг продолжается. /change <цена> — ручная смена.').catch(() => {});
                }
                await setAutoState({ state: 'cooldown' });
                updateAutoOverlayStatus('Таймаут 2FA. Возврат на главную...');
                await sleep(COOLDOWN_MS);
                window.location.href = P2P_MAIN_URL;
                return;
            }
        }

        await setStorage({ userPrice: target });
        await setAutoState({ state: 'cooldown', target });
        updateAutoOverlayStatus('Сохранено. Возврат на главную...');
        if (tgCfg.enabled) {
            await tgSend(`✅ Обновлено: ${target} THB.`).catch(() => {});
        }
        await sleep(COOLDOWN_MS);
        window.location.href = P2P_MAIN_URL;
    } catch (err) {
        console.error('Edit flow:', err);
        const msg = err.message || String(err);
        await setStorage({ autoUpdate: { state: 'aborted', reason: msg } });
        renderAutoOverlay(`Ошибка: ${msg}`, { showCancel: true, isError: true });
        playBeep();
        const cfg = await tgGetConfig();
        if (cfg.enabled) {
            await tgSend(`❌ Ошибка авто-обновления: ${msg}\n\nКоманды: /cancel — вернуть на главную и продолжить мониторинг, /change <цена> — попытка с другой ценой, /status.`).catch(() => {});
            // Recovery-поллер: позволяет удалённо разблокировать стак-стейт.
            runTgRecoveryLoop(cfg).catch(e => console.error('recovery loop:', e));
        }
    } finally {
        autoFlowRunning = false;
    }
}

// Ждём закрытия 2FA-модалки. Если конфиг Telegram включён — параллельно поллим Telegram:
// на сообщение с 6 цифрами вставляем код в BingX и кликаем Submit; число вида 37 / 36.55
// трактуем как «ставь мою цену».
// Возвращает: {type:'done'|'cancel'|'timeout'} | {type:'retarget', price}.
async function wait2FA(tgCfg, timeoutMs) {
    const start = Date.now();
    const MODAL_SEL = TWOFA_SEL.modal;
    const CODE_INPUT_SEL = TWOFA_SEL.input;
    const SUBMIT_SEL = TWOFA_SEL.submit;

    let offset = 0;
    if (tgCfg.enabled) {
        // На всякий случай снимаем webhook (если был настроен — getUpdates молча ломается).
        await tgDeleteWebhook(tgCfg.token);
        // Синхронизируем offset с хранилищем + пропускаем все старые апдейты.
        const { tgLastOffset } = await getStorage(['tgLastOffset']);
        offset = tgLastOffset || 0;
        try {
            const stale = await tgPollUpdates(tgCfg.token, offset, 0);
            console.log('[bingx-monitor] wait2FA stale updates:', stale.length, 'offset=', offset);
            if (stale.length) {
                offset = stale[stale.length - 1].update_id + 1;
                await setStorage({ tgLastOffset: offset });
            }
        } catch (e) {
            console.error('wait2FA stale drain error:', e);
            await tgSend(`⚠ getUpdates ошибка: ${e.description || e.message || e}`).catch(() => {});
        }
    }

    while (Date.now() - start < timeoutMs) {
        // (a) модалка исчезла — пользователь ввёл код вручную (VNC и т.п.)
        if (!document.querySelector(MODAL_SEL)) return { type: 'done' };

        if (tgCfg.enabled) {
            try {
                const updates = await tgPollUpdates(tgCfg.token, offset, 15);
                if (updates.length) console.log('[bingx-monitor] wait2FA got', updates.length, 'updates');
                for (const u of updates) {
                    offset = u.update_id + 1;
                    const msg = u.message;
                    if (!msg || !msg.chat) continue;
                    if (String(msg.chat.id) !== String(tgCfg.chatId)) {
                        console.log('[bingx-monitor] skipping msg from chat', msg.chat.id, 'expected', tgCfg.chatId);
                        continue;
                    }
                    const rawText = (msg.text || '').trim();
                    const text = rawText.replace(/\s+/g, ''); // убираем пробелы внутри (напр. "123 456")
                    console.log('[bingx-monitor] TG reply:', JSON.stringify(rawText));
                    if (/^\/?cancel$/i.test(text)) {
                        await setStorage({ tgLastOffset: offset });
                        await tgSend('❌ Отменено, слежу дальше.');
                        return { type: 'cancel' };
                    }
                    const codeMatch = text.match(/^\d{6}$/);
                    if (!codeMatch) {
                        const ownPrice = parseTgPrice(rawText);
                        if (ownPrice !== null) {
                            await setStorage({ tgLastOffset: offset });
                            return { type: 'retarget', price: ownPrice };
                        }
                        await tgSend(`Нужно 6 цифр 2FA, своя цена (напр. 37) или /cancel. Пришло: "${rawText}"`);
                        continue;
                    }
                    // Вводим код в модалку
                    try {
                        const codeInput = await waitForSelector(CODE_INPUT_SEL, 3000);
                        await setInputValueVue(codeInput, codeMatch[0]);
                        await sleep(300);
                        const submitBtn = await waitForSelector(SUBMIT_SEL, 3000);
                        submitBtn.click();
                    } catch (e) {
                        await tgSend(`❌ Не удалось ввести код: ${e.message || e}`);
                        await setStorage({ tgLastOffset: offset });
                        return { type: 'cancel' };
                    }
                    // Проверяем, закрылась ли модалка
                    try {
                        await waitForSelectorGone(MODAL_SEL, 10000);
                        await setStorage({ tgLastOffset: offset });
                        return { type: 'done' };
                    } catch (e) {
                        await tgSend('Код не принят, пришли актуальный (6 цифр).');
                    }
                }
                await setStorage({ tgLastOffset: offset });
            } catch (e) {
                console.error('wait2FA poll:', e);
                // Единоразово шлём в TG, чтоб юзер понял почему нет ответа
                if (!wait2FA._reportedError) {
                    wait2FA._reportedError = true;
                    await tgSend(`⚠ TG poll error: ${e.description || e.message || e}`).catch(() => {});
                }
                await sleep(3000);
            }
        } else {
            await sleep(500);
        }
    }
    return { type: 'timeout' };
}

// Recovery-поллер: запускается на edit-странице после ошибки/aborted. Поддерживает:
// /cancel — возврат на главную, мониторинг продолжается;
// /change <цена> — попытка снова, навигация на edit с новой целью;
// /status — отчёт по застрявшему состоянию;
// /help.
async function runTgRecoveryLoop(cfg) {
    const start = Date.now();
    const MAX_WAIT = 60 * 60 * 1000; // 1 час; после страница так и стоит — пользователь придёт домой и кликнет Отменить
    let { tgLastOffset } = await getStorage(['tgLastOffset']);
    let offset = tgLastOffset || 0;

    console.log('[bingx-monitor] TG recovery loop started');
    while (Date.now() - start < MAX_WAIT) {
        try {
            const updates = await tgPollUpdates(cfg.token, offset, 25);
            for (const u of updates) {
                offset = u.update_id + 1;
                const msg = u.message;
                if (!msg || !msg.chat) continue;
                if (String(msg.chat.id) !== String(cfg.chatId)) continue;
                const rawText = (msg.text || '').trim();
                const text = rawText.replace(/\s+/g, '');
                if (!rawText) continue;

                if (/^\/?cancel$/i.test(text)) {
                    await setStorage({ tgLastOffset: offset });
                    await tgSend('❌ Откат. Возвращаюсь на главную, мониторинг продолжается.');
                    await setAutoState({ state: 'cooldown' });
                    await sleep(500);
                    window.location.href = P2P_MAIN_URL;
                    return;
                }

                const changeMatch = rawText.match(/^\/?change\s+(\d+(?:[\.,]\d+)?)\s*$/i);
                const bareTarget = changeMatch ? null : parseTgPrice(rawText);
                if (changeMatch || bareTarget !== null) {
                    const target = changeMatch ? parseFloat(changeMatch[1].replace(',', '.')) : bareTarget;
                    if (isNaN(target) || target <= 0) {
                        await tgSend('Цена не парсится. /change 36.55');
                        continue;
                    }
                    const d = await getStorage(['lastOrderNo', 'userPrice']);
                    if (!d.lastOrderNo) {
                        await tgSend('Нет orderNo. Сначала /cancel и попробуй снова, когда будешь дома.');
                        continue;
                    }
                    await setStorage({ tgLastOffset: offset });
                    await tgSend(`⚠ Перепопытка: ${target} THB. Иду на edit, жду 2FA.`);
                    await setStorage({
                        autoUpdate: {
                            state: 'goto_edit',
                            target,
                            orderNo: d.lastOrderNo,
                            competitor: null,
                            oldPrice: d.userPrice,
                            startedAt: Date.now()
                        }
                    });
                    await sleep(300);
                    window.location.href = `${EDIT_URL_BASE}?orderNo=${encodeURIComponent(d.lastOrderNo)}`;
                    return;
                }

                if (/^\/?status$/i.test(text)) {
                    const d = await getStorage(['userPrice', 'autoUpdate', 'lastOrderNo']);
                    await tgSend([
                        '🛑 Состояние: aborted',
                        `Причина: ${d.autoUpdate?.reason || '—'}`,
                        `Цена в панели: ${d.userPrice ?? '—'} THB`,
                        `orderNo: ${d.lastOrderNo || '—'}`,
                        '',
                        'Доступно: /cancel, /change <цена>'
                    ].join('\n'));
                    continue;
                }

                if (/^\/?help$/i.test(text)) {
                    await tgSend([
                        'Я застрял на edit-странице. Команды:',
                        '/cancel — отбой, домой к мониторингу',
                        '/change 36.55 (или просто 36.55) — повторить с другой ценой',
                        '/status — детали'
                    ].join('\n'));
                    continue;
                }

                if (rawText.startsWith('/')) {
                    await tgSend(`Неизвестно: ${rawText}\n/help`);
                }
            }
            await setStorage({ tgLastOffset: offset });
        } catch (e) {
            console.error('recovery poll:', e);
            await sleep(5000);
        }
    }
    console.log('[bingx-monitor] TG recovery loop timed out (1 hour)');
}

// Постоянный TG-поллинг на главной P2P-странице. Слушает команды:
// /change <цена>, /status, /help. Команда /cancel живёт только в wait2FA.
async function startTgMainPoll() {
    if (tgMainPollCtx) return; // уже запущен
    if (!isOnMainPage()) return; // только на главной
    const cfg = await tgGetConfig();
    if (!cfg.enabled) return;

    const ctx = { aborted: false };
    tgMainPollCtx = ctx;
    console.log('[bingx-monitor] TG main poll started');

    await tgDeleteWebhook(cfg.token);

    let { tgLastOffset } = await getStorage(['tgLastOffset']);
    let offset = tgLastOffset || 0;

    // Дренаж старых апдейтов (не реагируем на команды, отправленные до запуска поллинга,
    // чтобы при перезапуске монитора не сработала /change годичной давности).
    try {
        const stale = await tgPollUpdates(cfg.token, offset, 0);
        if (stale.length) {
            offset = stale[stale.length - 1].update_id + 1;
            await setStorage({ tgLastOffset: offset });
        }
    } catch (e) {
        console.error('TG main stale drain:', e);
    }

    while (!ctx.aborted) {
        try {
            const updates = await tgPollUpdates(cfg.token, offset, 25);
            for (const u of updates) {
                offset = u.update_id + 1;
                if (ctx.aborted) break;
                const navigated = await handleTgMainCommand(cfg, u);
                if (navigated) {
                    await setStorage({ tgLastOffset: offset });
                    return; // страница уходит в навигацию
                }
            }
            await setStorage({ tgLastOffset: offset });
        } catch (e) {
            console.error('TG main poll:', e);
            await sleep(5000);
        }
    }
    console.log('[bingx-monitor] TG main poll stopped');
}

function stopTgMainPoll() {
    if (tgMainPollCtx) {
        tgMainPollCtx.aborted = true;
        tgMainPollCtx = null;
    }
}

// Возвращает true, если запустили навигацию (чтобы внешний цикл вышел).
async function handleTgMainCommand(cfg, update) {
    const msg = update.message;
    if (!msg || !msg.chat) return false;
    if (String(msg.chat.id) !== String(cfg.chatId)) return false;
    const rawText = (msg.text || '').trim();
    if (!rawText) return false;

    // /change <цена> или просто число
    const changeMatch = rawText.match(/^\/?change\s+(\d+(?:[\.,]\d+)?)\s*$/i);
    const bareTarget = changeMatch ? null : parseTgPrice(rawText);
    if (changeMatch || bareTarget !== null) {
        const target = changeMatch ? parseFloat(changeMatch[1].replace(',', '.')) : bareTarget;
        if (isNaN(target) || target <= 0) {
            await tgSend('Цена не парсится. Пример: /change 36.55');
            return false;
        }
        const d = await getStorage(['lastOrderNo', 'userPrice']);
        if (!d.lastOrderNo) {
            await tgSend('Нет сохранённого orderNo. Зайди дома вручную на /p2p/advert/edit?... один раз — он запомнится.');
            return false;
        }
        await tgSend(`⚠ Меняю на ${target} THB по команде. Иду на edit, жду 2FA.`);
        stopMonitoring();
        await setStorage({
            autoUpdate: {
                state: 'goto_edit',
                target,
                orderNo: d.lastOrderNo,
                competitor: null,
                oldPrice: d.userPrice,
                startedAt: Date.now()
            }
        });
        await sleep(300);
        window.location.href = `${EDIT_URL_BASE}?orderNo=${encodeURIComponent(d.lastOrderNo)}`;
        return true;
    }

    // /cap 37 — потолок продажи, /cap off — снять, /cap — показать текущий
    const capMatch = rawText.match(/^\/?(?:cap|потолок)(?:\s+(.+))?$/i);
    if (capMatch) {
        const arg = (capMatch[1] || '').trim();
        const d = await getStorage(['priceCeil', 'priceFloor']);
        if (!arg) {
            await tgSend(d.priceCeil
                ? `Потолок: ${d.priceCeil} THB. Снять — /cap off`
                : 'Потолок не задан. Поставить — /cap 37');
            return false;
        }
        if (/^(off|нет|снять|-|0)$/i.test(arg)) {
            await new Promise(resolve => chrome.storage.local.remove('priceCeil', resolve));
            await tgSend('Потолок снят — поднимаюсь под ближайшего конкурента.');
            return false;
        }
        const v = parseFloat(arg.replace(',', '.'));
        if (isNaN(v) || v <= 0) {
            await tgSend('Цена не парсится. Пример: /cap 37');
            return false;
        }
        if (d.priceFloor && v < d.priceFloor) {
            await tgSend(`Потолок ${v} ниже предела ${d.priceFloor} THB — так нельзя.`);
            return false;
        }
        await setStorage({ priceCeil: v });
        await tgSend(`Потолок: ${v} THB. Выше не поднимаюсь${d.priceFloor ? `, ниже ${d.priceFloor} не опускаюсь` : ''}.`);
        return false;
    }

    // /list — сводка по всем торговцам прямо сейчас
    if (/^\/?(list|стакан)$/i.test(rawText)) {
        const d = await getStorage(['merchantName', 'ignoredMerchants', 'userPrice', 'priceFloor', 'priceCeil']);
        const cleanInputName = d.merchantName ? removeEmojis(d.merchantName) : '';
        const ignored = d.ignoredMerchants
            ? d.ignoredMerchants.split(',').map(n => removeEmojis(n.trim())).filter(Boolean)
            : [];
        const summary = formatMerchantsSummary(
            collectMerchantRows(cleanInputName, ignored),
            { userPrice: d.userPrice, priceFloor: d.priceFloor, priceCeil: d.priceCeil }
        );
        await tgSend(summary || 'Таблица не читается — проверь селекторы на странице.', { html: !!summary });
        return false;
    }

    // /status
    if (/^\/?status$/i.test(rawText)) {
        const d = await getStorage(['userPrice', 'isMonitoring', 'lastOrderNo', 'autonomousMode', 'notAtHome', 'priceFloor', 'priceCeil', 'autoTotp', 'totpSecret']);
        const lines = [
            `Мониторинг: ${d.isMonitoring ? 'вкл' : 'выкл'}`,
            `Автоном: ${d.autonomousMode ? 'вкл' : 'выкл'}`,
            `Не на месте: ${d.notAtHome ? 'вкл' : 'выкл'}`,
            `Авто-2FA: ${(d.autoTotp && d.totpSecret) ? 'вкл' : 'выкл'}`,
            `Ваша цена: ${d.userPrice ?? '—'} THB`,
            `Предел: ${d.priceFloor ?? '—'} THB, потолок: ${d.priceCeil ?? '—'} THB`,
            `orderNo: ${d.lastOrderNo || '—'}`
        ];
        if (lastBeepedMinPrice != null) lines.push(`Послед. конкурент: ${lastBeepedMinPrice} THB`);
        await tgSend(lines.join('\n'));
        return false;
    }

    // /help
    if (/^\/?help$/i.test(rawText)) {
        await tgSend([
            'Команды:',
            '/change 36.55 (или просто 36.55) — изменить цену объявления (с 2FA через TG)',
            '/list — сводка по всем торговцам: цена / имя / доступно / лимиты',
            '/cap 37 — потолок: выше не поднимаюсь (/cap off — снять, /cap — показать)',
            '/status — текущее состояние',
            '/cancel — отмена в момент ожидания 2FA',
            'В момент ожидания 2FA: 6 цифр — код, число вроде 37 — своя цена вместо предложенной',
            '/help — это сообщение'
        ].join('\n'));
        return false;
    }

    // Неизвестные / явные команды
    if (rawText.startsWith('/')) {
        await tgSend(`Неизвестно: ${rawText}\nСм. /help`);
    }
    return false;
}

async function resumeAfterCooldown() {
    hideAutoOverlay();
    await resetAutoState();
    const { isMonitoring } = await getStorage(['isMonitoring']);
    if (isMonitoring && !monitoringIntervalId) {
        startMonitoring();
    }
}

async function handleAutoFlowOnInit() {
    // Автозахват orderNo при ручном заходе на edit-страницу (prefill sub-panel в будущем)
    const orderNoFromUrl = getOrderNoFromUrl(location.href);
    if (orderNoFromUrl) {
        const { lastOrderNo } = await getStorage(['lastOrderNo']);
        if (lastOrderNo !== orderNoFromUrl) {
            await setStorage({ lastOrderNo: orderNoFromUrl });
        }
    }

    const { autoUpdate } = await getStorage(['autoUpdate']);
    if (!autoUpdate || !autoUpdate.state || autoUpdate.state === 'idle') return;

    if (autoUpdate.state === 'goto_edit') {
        if (isOnEditPage()) {
            await runEditPageFlow(autoUpdate);
        } else {
            await setStorage({ autoUpdate: { state: 'aborted', reason: 'Не попали на edit-страницу' } });
            renderAutoOverlay('Ошибка навигации.', { showCancel: true, isError: true });
        }
    } else if (autoUpdate.state === 'cooldown') {
        if (isOnMainPage()) await resumeAfterCooldown();
    } else if (autoUpdate.state === 'aborted') {
        renderAutoOverlay(`Аборт: ${autoUpdate.reason || 'неизвестно'}`, { showCancel: true, isError: true });
    }
}

// ===== Panel =====
function createPanel() {
    if (document.getElementById('bingx-monitor-panel')) return;

    try {
        const panel = document.createElement('div');
        panel.id = 'bingx-monitor-panel';
        panel.innerHTML = `
      <div class="row">
        <button id="checkSelectors">Проверить селекторы</button>
        <button id="resetStorage">Сброс</button>
        <button id="startMonitoring">Начать</button>
        <button id="stopMonitoring" disabled>Остановить</button>
        <span id="alertMessages"></span>
      </div>
      <div class="row">
        <label>Цена (THB):</label>
        <input type="number" id="userPrice" step="0.001" placeholder="Ваша цена">
        <label>Предел (THB):</label>
        <input type="number" id="priceFloor" step="0.01" placeholder="ниже не опускаться">
        <label>Потолок (THB):</label>
        <input type="number" id="priceCeil" step="0.01" placeholder="выше не поднимать">
        <label>Игнорировать мерчантов:</label>
        <input type="text" id="ignoredMerchants" placeholder="User1,User2">
        <label>Имя мерчанта:</label>
        <input type="text" id="merchantName" placeholder="Ваше имя мерчанта">
        <label class="autonomous-label"><input type="checkbox" id="autonomousMode"> Автоном</label>
        <label class="autonomous-label"><input type="checkbox" id="notAtHome" disabled> Не на месте</label>
        <span id="status" class="status"></span>
        <span id="error" class="error"></span>
        <button id="toggle-panel">↑</button>
      </div>
      <div class="row telegram-row" id="telegramRow" style="display:none;">
        <label>TG bot token:</label>
        <input type="password" id="telegramToken" placeholder="1234567:AAAA...">
        <label>TG chat ID:</label>
        <input type="text" id="telegramChatId" placeholder="123456789">
        <button id="testTelegram">Тест</button>
        <span id="telegramStatus"></span>
      </div>
      <div class="row totp-row" id="totpRow" style="display:none;">
        <label class="autonomous-label"><input type="checkbox" id="autoTotp"> Авто-2FA</label>
        <label>Seed (base32):</label>
        <input type="password" id="totpSecret" placeholder="JBSWY3DP... или otpauth://">
        <button id="testTotp">Код</button>
        <span id="totpStatus"></span>
      </div>
      <div class="row alert-row" id="alertSubPanel" style="display:none;">
        <span class="alert-label">Цену перебили — изменить объявление:</span>
        <label>Новая цена:</label>
        <input type="number" id="newPrice" step="0.001" placeholder="напр. 36.120">
        <label>orderNo:</label>
        <input type="text" id="newOrderNo" placeholder="из URL редактирования">
        <button id="applyPriceChange">Изменить цену</button>
        <button id="closeAlert">Закрыть</button>
        <span id="alertError" class="error"></span>
      </div>
    `;
        document.body.prepend(panel);

        const toggleButtonContainer = document.createElement('div');
        toggleButtonContainer.id = 'toggle-button-container';
        document.body.prepend(toggleButtonContainer);

        chrome.storage.local.get(
            ['merchantName', 'userPrice', 'priceFloor', 'priceCeil', 'ignoredMerchants', 'isPanelCollapsed', 'isMonitoring', 'lastOrderNo',
             'autonomousMode', 'notAtHome', 'telegramToken', 'telegramChatId', 'autoTotp', 'totpSecret'],
            (data) => {
                if (data.merchantName) document.getElementById('merchantName').value = data.merchantName;
                if (data.userPrice) document.getElementById('userPrice').value = data.userPrice;
                if (typeof data.priceFloor === 'number') document.getElementById('priceFloor').value = data.priceFloor;
                if (typeof data.priceCeil === 'number') document.getElementById('priceCeil').value = data.priceCeil;
                if (data.ignoredMerchants) document.getElementById('ignoredMerchants').value = data.ignoredMerchants;
                if (data.lastOrderNo) document.getElementById('newOrderNo').value = data.lastOrderNo;
                const auto = !!data.autonomousMode;
                document.getElementById('autonomousMode').checked = auto;
                const naH = document.getElementById('notAtHome');
                naH.disabled = !auto;
                naH.checked = auto && !!data.notAtHome;
                if (data.telegramToken) document.getElementById('telegramToken').value = data.telegramToken;
                if (data.telegramChatId) document.getElementById('telegramChatId').value = data.telegramChatId;
                document.getElementById('telegramRow').style.display = naH.checked ? 'flex' : 'none';
                document.getElementById('autoTotp').checked = !!data.autoTotp;
                if (data.totpSecret) document.getElementById('totpSecret').value = data.totpSecret;
                document.getElementById('totpRow').style.display = auto ? 'flex' : 'none';

                if (data.isPanelCollapsed) {
                    panel.classList.add('collapsed');
                    const toggleButton = document.getElementById('toggle-panel');
                    toggleButton.textContent = '↓';
                    toggleButtonContainer.appendChild(toggleButton);
                }
                if (data.isMonitoring) {
                    document.getElementById('startMonitoring').disabled = true;
                    document.getElementById('stopMonitoring').disabled = false;
                    document.getElementById('status').textContent = 'Мониторинг запущен...';
                    if (!monitoringIntervalId) startMonitoring();
                }
            }
        );

        document.getElementById('merchantName').addEventListener('input', () => {
            chrome.storage.local.set({ merchantName: document.getElementById('merchantName').value.trim() });
        });
        document.getElementById('userPrice').addEventListener('input', () => {
            const v = parseFloat(document.getElementById('userPrice').value);
            if (!isNaN(v) && v > 0) chrome.storage.local.set({ userPrice: v });
        });
        document.getElementById('priceFloor').addEventListener('input', () => {
            const raw = document.getElementById('priceFloor').value.trim();
            if (raw === '') {
                chrome.storage.local.remove('priceFloor');
                return;
            }
            const v = parseFloat(raw);
            if (!isNaN(v) && v > 0) chrome.storage.local.set({ priceFloor: v });
        });
        document.getElementById('priceCeil').addEventListener('input', () => {
            const raw = document.getElementById('priceCeil').value.trim();
            if (raw === '') {
                chrome.storage.local.remove('priceCeil');
                return;
            }
            const v = parseFloat(raw);
            if (isNaN(v) || v <= 0) return;
            chrome.storage.local.set({ priceCeil: v });
            const floor = parseFloat(document.getElementById('priceFloor').value);
            if (!isNaN(floor) && floor > 0 && v < floor) {
                showMessage(`Потолок ${v} ниже предела ${floor} — потолок игнорируется.`);
            }
        });
        // Потолок и цена меняются и удалённо (/cap из Telegram, успешное авто-обновление) —
        // подтягиваем значения в поля, чтобы панель не показывала устаревшее.
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            [['priceCeil', 'priceCeil'], ['priceFloor', 'priceFloor'], ['userPrice', 'userPrice']].forEach(([key, id]) => {
                if (!changes[key]) return;
                const el = document.getElementById(id);
                if (!el || el === document.activeElement) return;
                const v = changes[key].newValue;
                el.value = (typeof v === 'number') ? v : '';
            });
        });

        document.getElementById('ignoredMerchants').addEventListener('input', () => {
            chrome.storage.local.set({ ignoredMerchants: document.getElementById('ignoredMerchants').value.trim() });
        });
        document.getElementById('autonomousMode').addEventListener('change', (e) => {
            const on = e.target.checked;
            chrome.storage.local.set({ autonomousMode: on });
            const naH = document.getElementById('notAtHome');
            naH.disabled = !on;
            document.getElementById('totpRow').style.display = on ? 'flex' : 'none';
            if (!on) {
                naH.checked = false;
                chrome.storage.local.set({ notAtHome: false });
                document.getElementById('telegramRow').style.display = 'none';
                stopTgMainPoll();
            }
        });
        document.getElementById('autoTotp').addEventListener('change', (e) => {
            chrome.storage.local.set({ autoTotp: e.target.checked });
        });
        document.getElementById('totpSecret').addEventListener('input', () => {
            const raw = document.getElementById('totpSecret').value.trim();
            const statusEl = document.getElementById('totpStatus');
            if (raw === '') {
                chrome.storage.local.remove('totpSecret');
                statusEl.textContent = '';
                return;
            }
            try {
                parseTotpSecret(raw);
                chrome.storage.local.set({ totpSecret: raw });
                statusEl.textContent = 'seed принят';
            } catch (err) {
                statusEl.textContent = err.message || String(err);
            }
        });
        // Сверка с телефоном: код живёт 30 сек, цифры должны совпасть с приложением.
        document.getElementById('testTotp').addEventListener('click', async () => {
            const statusEl = document.getElementById('totpStatus');
            const raw = document.getElementById('totpSecret').value.trim();
            try {
                const cfg = parseTotpSecret(raw);
                const code = await generateTotp(cfg);
                statusEl.textContent = `${code} (${totpSecondsLeft(cfg.period)} с)`;
            } catch (err) {
                statusEl.textContent = `Ошибка: ${err.message || err}`;
            }
        });
        document.getElementById('notAtHome').addEventListener('change', (e) => {
            const on = e.target.checked;
            chrome.storage.local.set({ notAtHome: on });
            document.getElementById('telegramRow').style.display = on ? 'flex' : 'none';
            if (on && monitoringIntervalId) {
                startTgMainPoll().catch(err => console.error('TG poll start:', err));
            } else {
                stopTgMainPoll();
            }
        });
        document.getElementById('telegramToken').addEventListener('input', () => {
            chrome.storage.local.set({ telegramToken: document.getElementById('telegramToken').value.trim() });
        });
        document.getElementById('telegramChatId').addEventListener('input', () => {
            chrome.storage.local.set({ telegramChatId: document.getElementById('telegramChatId').value.trim() });
        });
        document.getElementById('testTelegram').addEventListener('click', async () => {
            const token = document.getElementById('telegramToken').value.trim();
            const chatId = document.getElementById('telegramChatId').value.trim();
            const statusEl = document.getElementById('telegramStatus');
            if (!token || !chatId) {
                statusEl.textContent = 'Заполни токен и chat ID';
                statusEl.style.color = '#c62828';
                return;
            }
            statusEl.textContent = 'отправка...';
            statusEl.style.color = '#555';
            try {
                const res = await tgSendWith(token, chatId, 'BingX monitor: тест связи ✅');
                if (res.ok) {
                    statusEl.textContent = 'Отправлено';
                    statusEl.style.color = '#2e7d32';
                } else {
                    statusEl.textContent = 'Ошибка: ' + (res.description || 'неизвестно');
                    statusEl.style.color = '#c62828';
                }
            } catch (e) {
                statusEl.textContent = 'Ошибка: ' + (e.message || e);
                statusEl.style.color = '#c62828';
            }
        });

        document.getElementById('checkSelectors').addEventListener('click', () => {
            const { ok, counts } = checkSelectors();
            const detail = `строки: ${counts.rows}, цены: ${counts.price}, лимиты: ${counts.limit}, имена: ${counts.name}`;
            document.getElementById('status').textContent = ok ? `Селекторы найдены (${detail})` : '';
            document.getElementById('error').textContent = ok ? '' : `Селекторы не найдены — ${detail}`;
        });

        document.getElementById('resetStorage').addEventListener('click', () => {
            stopMonitoring();
            chrome.storage.local.clear(() => {
                document.getElementById('userPrice').value = '';
                document.getElementById('priceFloor').value = '';
                document.getElementById('priceCeil').value = '';
                document.getElementById('ignoredMerchants').value = '';
                document.getElementById('merchantName').value = '';
                document.getElementById('newPrice').value = '';
                document.getElementById('newOrderNo').value = '';
                document.getElementById('autonomousMode').checked = false;
                const naH = document.getElementById('notAtHome');
                naH.disabled = true;
                naH.checked = false;
                document.getElementById('telegramToken').value = '';
                document.getElementById('telegramChatId').value = '';
                document.getElementById('telegramRow').style.display = 'none';
                document.getElementById('telegramStatus').textContent = '';
                document.getElementById('autoTotp').checked = false;
                document.getElementById('totpSecret').value = '';
                document.getElementById('totpStatus').textContent = '';
                document.getElementById('totpRow').style.display = 'none';
                document.getElementById('status').textContent = 'Данные сброшены';
                document.getElementById('error').textContent = '';
                document.getElementById('startMonitoring').disabled = false;
                document.getElementById('stopMonitoring').disabled = true;
                hideAlertPanel();
            });
        });

        document.getElementById('startMonitoring').addEventListener('click', () => {
            const userPrice = parseFloat(document.getElementById('userPrice').value);
            const merchantName = document.getElementById('merchantName').value.trim();
            if (!userPrice && !merchantName) {
                document.getElementById('error').textContent = 'Введите хотя бы цену или имя мерчанта!';
                return;
            }
            if (userPrice && (isNaN(userPrice) || userPrice <= 0)) {
                document.getElementById('error').textContent = 'Введите корректную цену!';
                return;
            }
            ensureAudioContext();
            chrome.storage.local.set({ userPrice, merchantName, isMonitoring: true }, () => {
                startMonitoring();
                document.getElementById('status').textContent = 'Мониторинг запущен...';
                document.getElementById('error').textContent = '';
                document.getElementById('startMonitoring').disabled = true;
                document.getElementById('stopMonitoring').disabled = false;
            });
        });

        document.getElementById('stopMonitoring').addEventListener('click', () => {
            chrome.storage.local.set({ isMonitoring: false, previousLimit: null }, () => {
                stopMonitoring();
                document.getElementById('status').textContent = 'Мониторинг остановлен.';
                document.getElementById('startMonitoring').disabled = false;
                document.getElementById('stopMonitoring').disabled = true;
            });
        });

        document.getElementById('applyPriceChange').addEventListener('click', onApplyPriceChange);
        document.getElementById('closeAlert').addEventListener('click', () => {
            alertPanelDismissed = true;
            hideAlertPanel();
        });

        document.getElementById('toggle-panel').addEventListener('click', () => {
            const panelEl = document.getElementById('bingx-monitor-panel');
            const toggleButton = document.getElementById('toggle-panel');
            const container = document.getElementById('toggle-button-container');
            const isCollapsed = panelEl.classList.toggle('collapsed');
            if (isCollapsed) {
                toggleButton.textContent = '↓';
                container.appendChild(toggleButton);
            } else {
                toggleButton.textContent = '↑';
                panelEl.appendChild(toggleButton);
            }
            chrome.storage.local.set({ isPanelCollapsed: isCollapsed });
        });
    } catch (e) {
        console.error('createPanel:', e);
    }
}

// ===== Init =====
function init() {
    try {
        handleAutoFlowOnInit().catch(e => console.error('handleAutoFlow:', e));

        const tryCreatePanel = () => {
            if (document.querySelector('.p2p-adverts-table') || isOnMainPage()) {
                createPanel();
            }
        };

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            tryCreatePanel();
        } else {
            document.addEventListener('DOMContentLoaded', tryCreatePanel);
        }

        const observer = new MutationObserver(() => {
            if (!document.getElementById('bingx-monitor-panel') && document.querySelector('.p2p-adverts-table')) {
                createPanel();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
        console.error('init:', e);
    }
}

init();