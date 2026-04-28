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
const SANITY_MAX_PCT = 0.10;
const ELEMENT_TIMEOUT_MS = 15000;
const MODAL_APPEAR_TIMEOUT_MS = 10000;
const TWOFA_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 2000;

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

async function tgSend(text) {
    const { token, chatId, enabled } = await tgGetConfig();
    if (!enabled) return false;
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
        });
        const json = await res.json();
        if (!json.ok) console.warn('TG sendMessage not ok:', json);
        return json.ok;
    } catch (e) {
        console.error('TG send:', e);
        return false;
    }
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
function showAlertPanel(minCompetitorPrice, minCompetitorStr) {
    if (alertPanelDismissed) return;
    const el = document.getElementById('alertSubPanel');
    if (!el) return;
    if (!alertPanelShown) {
        const suggested = minCompetitorStr
            ? computeSuggestedPrice(minCompetitorStr)
            : Number((minCompetitorPrice - MIN_TICK).toFixed(3));
        const newPriceEl = document.getElementById('newPrice');
        if (newPriceEl && !newPriceEl.value && suggested !== null) newPriceEl.value = suggested;
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

async function triggerAutonomousEdit(minPrice, minPriceStr, oldPrice, orderNo) {
    const { autoUpdate } = await getStorage(['autoUpdate']);
    if (autoUpdate && autoUpdate.state && autoUpdate.state !== 'idle') return;

    const target = minPriceStr ? computeSuggestedPrice(minPriceStr) : null;
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
            competitor: minPrice,
            oldPrice,
            startedAt: Date.now()
        }
    });
    showMessage(`Автоном: ${oldPrice} → ${target} (конкурент ${minPrice}). Переход...`);
    tgSend(`⚠ Перебили. Конкурент: ${minPrice} THB. Ваша: ${oldPrice} THB. Меняю на ${target} THB.`).catch(() => {});
    await sleep(300);
    window.location.href = `${EDIT_URL_BASE}?orderNo=${encodeURIComponent(orderNo)}`;
}

// ===== Core monitoring =====
function checkSelectors() {
    const rows = document.querySelectorAll('.p2p-adverts-table .row-item');
    const priceElements = document.querySelectorAll('.number.line-height20.text1.weight-bolder.font18');
    const limitElements = document.querySelectorAll('.flex.column-direction.text1.number.gap4.line-height22 > span:first-child');
    return rows.length > 0 && priceElements.length > 0 && limitElements.length > 0;
}

function performCycle() {
    chrome.storage.local.get(
        ['userPrice', 'merchantName', 'ignoredMerchants', 'isMonitoring', 'previousLimit', 'autonomousMode', 'lastOrderNo'],
        (data) => {
            if (!data.isMonitoring) {
                stopMonitoring();
                return;
            }

            const userPrice = data.userPrice;
            const merchantName = data.merchantName;
            const ignoredMerchants = data.ignoredMerchants
                ? data.ignoredMerchants.split(',').map(n => removeEmojis(n.trim())).filter(Boolean)
                : [];

            try {
                const rows = document.querySelectorAll('.p2p-adverts-table .row-item');
                let minPrice = Infinity;
                let minPriceStr = null;
                let foundOwnRow = false;
                let currentLimit = null;

                rows.forEach((row) => {
                    const nameEl = row.querySelector('.cursor-pointer.ellipsis.weight-bolder');
                    const priceEl = row.querySelector('.number.line-height20.text1.weight-bolder.font18');
                    const limitEl = row.querySelector('.flex.column-direction.text1.number.gap4.line-height22 > span:first-child');

                    if (priceEl && userPrice) {
                        const cleanName = nameEl ? removeEmojis(nameEl.textContent.trim()) : '';
                        if (!ignoredMerchants.includes(cleanName)) {
                            const priceText = priceEl.textContent.replace(' THB', '').replace(/,/g, '').trim();
                            const price = parseFloat(priceText);
                            if (!isNaN(price) && price < minPrice) {
                                minPrice = price;
                                minPriceStr = priceText;
                            }
                        }
                    }

                    if (nameEl && limitEl && merchantName) {
                        const cleanName = removeEmojis(nameEl.textContent.trim());
                        const cleanInputName = removeEmojis(merchantName);
                        if (cleanName.includes(cleanInputName)) {
                            foundOwnRow = true;
                            const limitText = limitEl.textContent.replace(' USDT', '').replace(/,/g, '').trim();
                            const parsed = parseFloat(limitText);
                            if (!isNaN(parsed)) currentLimit = parsed;
                        }
                    }
                });

                if (userPrice && minPrice < userPrice) {
                    const now = Date.now();
                    const priceChanged = lastBeepedMinPrice !== minPrice;
                    const timeToRemind = now - lastPriceBelowBeepAt >= PRICE_BELOW_BEEP_INTERVAL_MS;
                    if (priceChanged || timeToRemind) {
                        playBeep();
                        showMessage(`Найдена цена ниже вашей: ${minPrice} THB!`);
                        lastBeepedMinPrice = minPrice;
                        lastPriceBelowBeepAt = now;
                    }

                    if (data.autonomousMode && data.lastOrderNo) {
                        triggerAutonomousEdit(minPrice, minPriceStr, userPrice, data.lastOrderNo)
                            .catch(err => {
                                console.error('Autonomous trigger:', err);
                                showAlertPanel(minPrice, minPriceStr);
                            });
                    } else {
                        if (data.autonomousMode && !data.lastOrderNo) {
                            showMessage('Автоном: orderNo не захвачен. Открой edit вручную один раз.');
                        }
                        showAlertPanel(minPrice, minPriceStr);
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

// ===== Edit page flow =====
async function runEditPageFlow(params) {
    if (autoFlowRunning) return;
    autoFlowRunning = true;

    const { competitor, oldPrice } = params;
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
                throw new Error(`Санитарный диапазон: ${currentValue} → ${target} = ${(diffPct * 100).toFixed(1)}% (>10%). Отмена.`);
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
        await waitForSelector('.security-verify-entry', MODAL_APPEAR_TIMEOUT_MS);

        renderAutoOverlayWith2FAInfo({
            status: 'Введите код Google Authenticator. Мониторинг возобновится автоматически после успеха.',
            competitor, oldPrice, target
        });

        const tgCfg = await tgGetConfig();
        if (tgCfg.enabled) {
            const lines = ['⏸ Дошёл до 2FA.'];
            if (competitor != null) lines.push(`Конкурент: ${competitor} THB`);
            if (oldPrice != null) lines.push(`Ваша: ${oldPrice} THB`);
            if (target != null) lines.push(`Новая: ${target} THB`);
            lines.push('', 'Пришли 6 цифр 2FA (или /cancel).');
            await tgSend(lines.join('\n'));
        }

        const outcome = await wait2FA(tgCfg, TWOFA_WAIT_TIMEOUT_MS);
        if (outcome === 'cancel') {
            // Soft cancel — цена не сохранена, но возвращаемся на главную и продолжаем мониторинг.
            // Уведомление в TG уже отправлено из wait2FA одним сообщением.
            await setAutoState({ state: 'cooldown' });
            updateAutoOverlayStatus('Отменено. Возврат на главную...');
            await sleep(COOLDOWN_MS);
            window.location.href = P2P_MAIN_URL;
            return;
        }
        if (outcome === 'timeout') {
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
// на сообщение с 6 цифрами вставляем код в BingX и кликаем Submit.
// Возвращает: 'done' | 'cancel' | 'timeout'.
async function wait2FA(tgCfg, timeoutMs) {
    const start = Date.now();
    const MODAL_SEL = '.security-verify-entry';
    const CODE_INPUT_SEL = '.tl-input-inner';
    const SUBMIT_SEL = '.submit-btn';

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
        if (!document.querySelector(MODAL_SEL)) return 'done';

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
                        return 'cancel';
                    }
                    const codeMatch = text.match(/^\d{6}$/);
                    if (!codeMatch) {
                        await tgSend(`Нужно ровно 6 цифр или /cancel. Пришло: "${rawText}"`);
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
                        return 'cancel';
                    }
                    // Проверяем, закрылась ли модалка
                    try {
                        await waitForSelectorGone(MODAL_SEL, 10000);
                        await setStorage({ tgLastOffset: offset });
                        return 'done';
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
    return 'timeout';
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
                if (changeMatch) {
                    const target = parseFloat(changeMatch[1].replace(',', '.'));
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
                        '/change 36.55 — повторить с другой ценой',
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

    // /change <цена>
    const changeMatch = rawText.match(/^\/?change\s+(\d+(?:[\.,]\d+)?)\s*$/i);
    if (changeMatch) {
        const target = parseFloat(changeMatch[1].replace(',', '.'));
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

    // /status
    if (/^\/?status$/i.test(rawText)) {
        const d = await getStorage(['userPrice', 'isMonitoring', 'lastOrderNo', 'autonomousMode', 'notAtHome']);
        const lines = [
            `Мониторинг: ${d.isMonitoring ? 'вкл' : 'выкл'}`,
            `Автоном: ${d.autonomousMode ? 'вкл' : 'выкл'}`,
            `Не на месте: ${d.notAtHome ? 'вкл' : 'выкл'}`,
            `Ваша цена: ${d.userPrice ?? '—'} THB`,
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
            '/change 36.55 — изменить цену объявления (с 2FA через TG)',
            '/status — текущее состояние',
            '/cancel — отмена в момент ожидания 2FA',
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
            ['merchantName', 'userPrice', 'ignoredMerchants', 'isPanelCollapsed', 'isMonitoring', 'lastOrderNo',
             'autonomousMode', 'notAtHome', 'telegramToken', 'telegramChatId'],
            (data) => {
                if (data.merchantName) document.getElementById('merchantName').value = data.merchantName;
                if (data.userPrice) document.getElementById('userPrice').value = data.userPrice;
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
        document.getElementById('ignoredMerchants').addEventListener('input', () => {
            chrome.storage.local.set({ ignoredMerchants: document.getElementById('ignoredMerchants').value.trim() });
        });
        document.getElementById('autonomousMode').addEventListener('change', (e) => {
            const on = e.target.checked;
            chrome.storage.local.set({ autonomousMode: on });
            const naH = document.getElementById('notAtHome');
            naH.disabled = !on;
            if (!on) {
                naH.checked = false;
                chrome.storage.local.set({ notAtHome: false });
                document.getElementById('telegramRow').style.display = 'none';
                stopTgMainPoll();
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
            const ok = checkSelectors();
            document.getElementById('status').textContent = ok ? 'Селекторы найдены!' : '';
            document.getElementById('error').textContent = ok ? '' : 'Селекторы не найдены!';
        });

        document.getElementById('resetStorage').addEventListener('click', () => {
            stopMonitoring();
            chrome.storage.local.clear(() => {
                document.getElementById('userPrice').value = '';
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