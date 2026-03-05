function removeEmojis(text) {
    return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{200D}\u{FE0F}]/gu, '').trim();
}

function showMessage(message) {
    const alertMessages = document.getElementById('alertMessages');
    if (alertMessages) {
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
}

function createPanel() {
    if (document.getElementById('bingx-monitor-panel')) {
        console.log('Panel already exists');
        return;
    }

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
        console.log('Panel and toggle button container created successfully');

        // Загрузка сохранённых данных
        chrome.storage.local.get(['merchantName', 'userPrice', 'ignoredMerchants', 'isPanelCollapsed'], (data) => {
            if (data.merchantName) {
                document.getElementById('merchantName').value = data.merchantName;
            }
            if (data.userPrice) {
                document.getElementById('userPrice').value = data.userPrice;
            }
            if (data.ignoredMerchants) {
                document.getElementById('ignoredMerchants').value = data.ignoredMerchants;
            }
            if (data.isPanelCollapsed) {
                panel.classList.add('collapsed');
                const toggleButton = document.getElementById('toggle-panel');
                toggleButton.textContent = '↓';
                toggleButtonContainer.appendChild(toggleButton);
            }
        });

        // Сохранение имени мерчанта
        document.getElementById('merchantName').addEventListener('input', () => {
            const merchantName = document.getElementById('merchantName').value.trim();
            chrome.storage.local.set({ merchantName });
        });

        // Сохранение цены
        document.getElementById('userPrice').addEventListener('input', () => {
            const userPrice = parseFloat(document.getElementById('userPrice').value);
            if (!isNaN(userPrice) && userPrice > 0) {
                chrome.storage.local.set({ userPrice });
            }
        });

        // Сохранение игнорируемых мерчантов
        document.getElementById('ignoredMerchants').addEventListener('input', () => {
            const ignoredMerchants = document.getElementById('ignoredMerchants').value.trim();
            chrome.storage.local.set({ ignoredMerchants });
        });

        // Проверка селекторов
        document.getElementById('checkSelectors').addEventListener('click', () => {
            const result = checkSelectors();
            if (result) {
                document.getElementById('status').textContent = 'Селекторы найдены!';
                document.getElementById('error').textContent = '';
                console.log('Selectors found');
            } else {
                document.getElementById('error').textContent = 'Селекторы не найдены!';
                document.getElementById('status').textContent = '';
                console.log('Selectors not found');
            }
        });

        // Сброс данных
        document.getElementById('resetStorage').addEventListener('click', () => {
            chrome.storage.local.clear(() => {
                document.getElementById('userPrice').value = '';
                document.getElementById('ignoredMerchants').value = '';
                document.getElementById('merchantName').value = '';
                document.getElementById('status').textContent = 'Данные сброшены';
                document.getElementById('error').textContent = '';
                document.getElementById('startMonitoring').disabled = false;
                document.getElementById('stopMonitoring').disabled = true;
                console.log('Storage cleared');
            });
        });

        // Мониторинг
        document.getElementById('startMonitoring').addEventListener('click', () => {
            const userPrice = parseFloat(document.getElementById('userPrice').value);
            const merchantName = document.getElementById('merchantName').value.trim();
            if (!userPrice && !merchantName) {
                document.getElementById('error').textContent = 'Введите хотя бы цену или имя мерчанта!';
                console.log('Invalid input: both price and merchant name are empty');
                return;
            }
            if (userPrice && (isNaN(userPrice) || userPrice <= 0)) {
                document.getElementById('error').textContent = 'Введите корректную цену!';
                console.log('Invalid price entered');
                return;
            }
            chrome.storage.local.set({ userPrice, merchantName, isMonitoring: true }, () => {
                startAutoSwitchMonitoring();
                document.getElementById('status').textContent = 'Мониторинг запущен...';
                document.getElementById('error').textContent = '';
                document.getElementById('startMonitoring').disabled = true;
                document.getElementById('stopMonitoring').disabled = false;
                console.log('Monitoring started with price:', userPrice, 'merchant:', merchantName);
            });
        });

        document.getElementById('stopMonitoring').addEventListener('click', () => {
            chrome.storage.local.set({ isMonitoring: false, previousLimit: null }, () => {
                document.getElementById('status').textContent = 'Мониторинг остановлен.';
                document.getElementById('startMonitoring').disabled = false;
                document.getElementById('stopMonitoring').disabled = true;
                console.log('Monitoring stopped');
            });
        });

        // Сворачивание/разворачивание панели
        document.getElementById('toggle-panel').addEventListener('click', () => {
            const panel = document.getElementById('bingx-monitor-panel');
            const toggleButton = document.getElementById('toggle-panel');
            const toggleButtonContainer = document.getElementById('toggle-button-container');
            const isCollapsed = panel.classList.toggle('collapsed');

            if (isCollapsed) {
                toggleButton.textContent = '↓';
                toggleButtonContainer.appendChild(toggleButton);
            } else {
                toggleButton.textContent = '↑';
                panel.appendChild(toggleButton);
            }

            chrome.storage.local.set({ isPanelCollapsed: isCollapsed });
            console.log('Panel toggled, collapsed:', isCollapsed);
        });
    } catch (error) {
        console.error('Error creating panel:', error);
    }
}

function checkSelectors() {
    const rows = document.querySelectorAll('.p2p-adverts-table .row-item');
    const priceElements = document.querySelectorAll('.number.line-height20.text1.weight-bolder.font18');
    const limitElements = document.querySelectorAll('.flex.column-direction.text1.number.gap4.line-height22 > span:first-child');
    const buySellButtons = document.querySelectorAll('.bx-segmented-item .bx-segmented-label');
    console.log('Rows found:', rows.length, 'Price elements found:', priceElements.length, 'Limit elements found:', limitElements.length, 'Buy/Sell buttons found:', buySellButtons.length);
    return rows.length > 0 && priceElements.length > 0 && limitElements.length > 0 && buySellButtons.length >= 2;
}

function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(800, ctx.currentTime);
        oscillator.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.3);
        console.log('Beep played');
    } catch (error) {
        console.error('Error playing beep:', error);
    }
}

async function switchToSell() {
    const buttons = document.querySelectorAll('.bx-segmented-item .bx-segmented-label');
    for (const button of buttons) {
        if (button.textContent.trim() === 'Продать') {
            button.click();
            console.log('Switched to Sell');
            return true;
        }
    }
    console.log('Sell button not found');
    document.getElementById('error').textContent = 'Кнопка "Продать" не найдена!';
    return false;
}

async function switchToBuy() {
    const buttons = document.querySelectorAll('.bx-segmented-item .bx-segmented-label');
    for (const button of buttons) {
        if (button.textContent.trim() === 'Купить') {
            button.click();
            console.log('Switched to Buy');
            return true;
        }
    }
    console.log('Buy button not found');
    document.getElementById('error').textContent = 'Кнопка "Купить" не найдена!';
    return false;
}

function startAutoSwitchMonitoring() {
    chrome.storage.local.get(['userPrice', 'merchantName', 'ignoredMerchants', 'isMonitoring', 'previousLimit'], async (data) => {
        const userPrice = data.userPrice;
        const merchantName = data.merchantName;
        const ignoredMerchants = data.ignoredMerchants ? data.ignoredMerchants.split(',').map(name => removeEmojis(name.trim())).filter(name => name) : [];
        if (!data.isMonitoring) {
            console.log('Monitoring not started: isMonitoring is false');
            return;
        }

        let intervalId = null;

        const performCycle = async () => {
            chrome.storage.local.get(['isMonitoring', 'previousLimit'], async (storageData) => {
                if (!storageData.isMonitoring) {
                    console.log('Monitoring stopped');
                    if (intervalId) clearInterval(intervalId);
                    return;
                }

                try {
                    // Переключение на "Продать"
                    const sellSuccess = await switchToSell();
                    if (!sellSuccess) return;
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Ждать 3 секунды

                    // Переключение на "Купить"
                    const buySuccess = await switchToBuy();
                    if (!buySuccess) return;
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Ждать 3 секунды

                    // Проверка таблицы на вкладке "Купить"
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
                                const limitText = limitEl.textContent.replace(' USDT', '').replace(',', '').trim();
                                currentLimit = parseFloat(limitText);
                            }
                        }
                    });

                    // Проверка цен
                    if (userPrice && minPrice < userPrice) {
                        playBeep();
                        showMessage(`Найдена цена ниже вашей: ${minPrice} THB!`);
                    }

                    // Проверка лимита
                    if (merchantName) {
                        if (foundOwnRow) {
                            const previousLimit = storageData.previousLimit;
                            if (previousLimit !== null && currentLimit !== previousLimit) {
                                playBeep();
                                showMessage(`Лимит изменился! Новый: ${currentLimit} USDT (предыдущий: ${previousLimit} USDT)`);
                            }
                            chrome.storage.local.set({ previousLimit: currentLimit });
                            document.getElementById('error').textContent = '';
                        } else {
                            document.getElementById('error').textContent = 'Ваш ряд не найден!';
                            console.log('Own row not found for merchant:', merchantName);
                            // Сигнал, если ряд исчез (был ранее, но теперь не найден)
                            if (storageData.previousLimit !== null) {
                                playBeep();
                                showMessage('Ваш ряд исчез! USDT выкуплены?');
                                chrome.storage.local.set({ previousLimit: null }); // Сброс, чтобы не сигнализировать повторно
                            }
                        }
                    }

                    console.log('Auto-switch mode - Checked prices, min price:', minPrice, 'User price:', userPrice, 'Current limit:', currentLimit, 'Previous limit:', storageData.previousLimit, 'Ignored merchants:', ignoredMerchants);
                } catch (error) {
                    console.error('Error in auto-switch monitoring:', error);
                }
            });
        };

        performCycle();
        intervalId = setInterval(performCycle, 10000);
    });
}

// Запуск создания панели с наблюдателем за DOM
function init() {
    try {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            createPanel();
        } else {
            document.addEventListener('DOMContentLoaded', createPanel);
        }

        const observer = new MutationObserver(() => {
            if (!document.getElementById('bingx-monitor-panel') && document.querySelector('.p2p-adverts-table')) {
                console.log('Table detected, creating panel');
                createPanel();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    } catch (error) {
        console.error('Error initializing extension:', error);
    }
}

init();
