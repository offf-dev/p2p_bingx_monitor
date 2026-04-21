let monitoringIntervalId = null;
let audioCtx = null;
let lastBeepedMinPrice = null;
let lastPriceBelowBeepAt = 0;
let missingRowCount = 0;

const PRICE_BELOW_BEEP_INTERVAL_MS = 30000;

function removeEmojis(text) {
    return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{200D}\u{FE0F}]/gu, '').trim();
}

function showMessage(message) {
    const alertMessages = document.getElementById('alertMessages');
    if (!alertMessages) return;
    alertMessages.textContent = message;
    alertMessages.classList.remove('fade-out');
    setTimeout(() => {
        alertMessages.classList.add('fade-out');
        setTimeout(() => {
            alertMessages.textContent = '';
            alertMessages.classList.remove('fade-out');
        }, 500);
    }, 5000);
}

function ensureAudioContext() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (error) {
            console.error('Error creating AudioContext:', error);
            return null;
        }
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(err => console.error('Resume error:', err));
    }
    return audioCtx;
}

function playBeep() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const oscillator = ctx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(800, ctx.currentTime);
        oscillator.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.3);
    } catch (error) {
        console.error('Error playing beep:', error);
    }
}

function checkSelectors() {
    const rows = document.querySelectorAll('.p2p-adverts-table .row-item');
    const priceElements = document.querySelectorAll('.number.line-height20.text1.weight-bolder.font18');
    const limitElements = document.querySelectorAll('.flex.column-direction.text1.number.gap4.line-height22 > span:first-child');
    console.log('Rows:', rows.length, 'Prices:', priceElements.length, 'Limits:', limitElements.length);
    return rows.length > 0 && priceElements.length > 0 && limitElements.length > 0;
}

function performCycle() {
    chrome.storage.local.get(['userPrice', 'merchantName', 'ignoredMerchants', 'isMonitoring', 'previousLimit'], (data) => {
        if (!data.isMonitoring) {
            stopMonitoring();
            return;
        }

        const userPrice = data.userPrice;
        const merchantName = data.merchantName;
        const ignoredMerchants = data.ignoredMerchants
            ? data.ignoredMerchants.split(',').map(name => removeEmojis(name.trim())).filter(Boolean)
            : [];

        try {
            const rows = document.querySelectorAll('.p2p-adverts-table .row-item');
            let minPrice = Infinity;
            let foundOwnRow = false;
            let currentLimit = null;

            rows.forEach((row) => {
                const nameEl = row.querySelector('.cursor-pointer.ellipsis.weight-bolder');
                const priceEl = row.querySelector('.number.line-height20.text1.weight-bolder.font18');
                const limitEl = row.querySelector('.flex.column-direction.text1.number.gap4.line-height22 > span:first-child');

                if (priceEl && userPrice) {
                    const cleanName = nameEl ? removeEmojis(nameEl.textContent.trim()) : '';
                    if (!ignoredMerchants.includes(cleanName)) {
                        const priceText = priceEl.textContent.replace(' THB', '').trim();
                        const price = parseFloat(priceText);
                        if (!isNaN(price) && price < minPrice) minPrice = price;
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

            // Цены конкурентов: сигналим при изменении минимальной цены + напоминание каждые 30 сек, пока она ниже нашей
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
            } else {
                lastBeepedMinPrice = null;
                lastPriceBelowBeepAt = 0;
            }

            // Свой ряд и изменение лимита
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
                    // Сигналим только если ряд отсутствует 2 цикла подряд и раньше он точно был
                    if (missingRowCount >= 2 && typeof data.previousLimit === 'number') {
                        playBeep();
                        showMessage('Ваш ряд исчез! USDT выкуплены?');
                        chrome.storage.local.set({ previousLimit: null });
                        missingRowCount = 0;
                    }
                }
            }

            console.log('Cycle. minPrice:', minPrice, 'userPrice:', userPrice, 'currentLimit:', currentLimit, 'previousLimit:', data.previousLimit, 'missing:', missingRowCount);
        } catch (error) {
            console.error('Error in monitoring cycle:', error);
        }
    });
}

function startMonitoring() {
    stopMonitoring();
    lastBeepedMinPrice = null;
    lastPriceBelowBeepAt = 0;
    missingRowCount = 0;
    performCycle();
    monitoringIntervalId = setInterval(performCycle, 10000);
    console.log('Monitoring started');
}

function stopMonitoring() {
    if (monitoringIntervalId) {
        clearInterval(monitoringIntervalId);
        monitoringIntervalId = null;
        console.log('Monitoring interval cleared');
    }
}

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
        <span id="status" class="status"></span>
        <span id="error" class="error"></span>
        <button id="toggle-panel">↑</button>
      </div>
    `;
        document.body.prepend(panel);

        const toggleButtonContainer = document.createElement('div');
        toggleButtonContainer.id = 'toggle-button-container';
        document.body.prepend(toggleButtonContainer);

        chrome.storage.local.get(
            ['merchantName', 'userPrice', 'ignoredMerchants', 'isPanelCollapsed', 'isMonitoring'],
            (data) => {
                if (data.merchantName) document.getElementById('merchantName').value = data.merchantName;
                if (data.userPrice) document.getElementById('userPrice').value = data.userPrice;
                if (data.ignoredMerchants) document.getElementById('ignoredMerchants').value = data.ignoredMerchants;
                if (data.isPanelCollapsed) {
                    panel.classList.add('collapsed');
                    const toggleButton = document.getElementById('toggle-panel');
                    toggleButton.textContent = '↓';
                    toggleButtonContainer.appendChild(toggleButton);
                }
                // Восстановление активного мониторинга после перезагрузки страницы / пересоздания панели
                if (data.isMonitoring) {
                    document.getElementById('startMonitoring').disabled = true;
                    document.getElementById('stopMonitoring').disabled = false;
                    document.getElementById('status').textContent = 'Мониторинг запущен...';
                    if (!monitoringIntervalId) startMonitoring();
                }
            }
        );

        document.getElementById('merchantName').addEventListener('input', () => {
            const merchantName = document.getElementById('merchantName').value.trim();
            chrome.storage.local.set({ merchantName });
        });

        document.getElementById('userPrice').addEventListener('input', () => {
            const userPrice = parseFloat(document.getElementById('userPrice').value);
            if (!isNaN(userPrice) && userPrice > 0) {
                chrome.storage.local.set({ userPrice });
            }
        });

        document.getElementById('ignoredMerchants').addEventListener('input', () => {
            const ignoredMerchants = document.getElementById('ignoredMerchants').value.trim();
            chrome.storage.local.set({ ignoredMerchants });
        });

        document.getElementById('checkSelectors').addEventListener('click', () => {
            const result = checkSelectors();
            if (result) {
                document.getElementById('status').textContent = 'Селекторы найдены!';
                document.getElementById('error').textContent = '';
            } else {
                document.getElementById('error').textContent = 'Селекторы не найдены!';
                document.getElementById('status').textContent = '';
            }
        });

        document.getElementById('resetStorage').addEventListener('click', () => {
            stopMonitoring();
            chrome.storage.local.clear(() => {
                document.getElementById('userPrice').value = '';
                document.getElementById('ignoredMerchants').value = '';
                document.getElementById('merchantName').value = '';
                document.getElementById('status').textContent = 'Данные сброшены';
                document.getElementById('error').textContent = '';
                document.getElementById('startMonitoring').disabled = false;
                document.getElementById('stopMonitoring').disabled = true;
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
            // Инициализируем AudioContext на пользовательском жесте, иначе звук будет заблокирован
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
    } catch (error) {
        console.error('Error creating panel:', error);
    }
}

function init() {
    try {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            createPanel();
        } else {
            document.addEventListener('DOMContentLoaded', createPanel);
        }

        const observer = new MutationObserver(() => {
            if (!document.getElementById('bingx-monitor-panel') && document.querySelector('.p2p-adverts-table')) {
                createPanel();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    } catch (error) {
        console.error('Error initializing extension:', error);
    }
}

init();