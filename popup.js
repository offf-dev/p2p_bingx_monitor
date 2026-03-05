document.getElementById('checkSelectors').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            function: checkSelectors
        }, (results) => {
            if (chrome.runtime.lastError) {
                document.getElementById('error').textContent = 'Ошибка: страница не доступна';
                return;
            }
            if (results[0].result) {
                document.getElementById('status').textContent = 'Селекторы найдены!';
                document.getElementById('error').textContent = '';
            } else {
                document.getElementById('error').textContent = 'Селекторы не найдены. Убедитесь, что вы на странице P2P BingX.';
                document.getElementById('status').textContent = '';
            }
        });
    });
});

document.getElementById('startMonitoring').addEventListener('click', () => {
    const userPrice = parseFloat(document.getElementById('userPrice').value);
    if (!userPrice || userPrice <= 0) {
        document.getElementById('error').textContent = 'Введите корректную цену!';
        return;
    }
    chrome.storage.local.set({ userPrice, isMonitoring: true }, () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                function: startMonitoring
            });
            document.getElementById('status').textContent = 'Мониторинг запущен...';
            document.getElementById('error').textContent = '';
            document.getElementById('startMonitoring').disabled = true;
            document.getElementById('stopMonitoring').disabled = false;
        });
    });
});

document.getElementById('stopMonitoring').addEventListener('click', () => {
    chrome.storage.local.set({ isMonitoring: false }, () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                function: stopMonitoring
            });
            document.getElementById('status').textContent = 'Мониторинг остановлен.';
            document.getElementById('startMonitoring').disabled = false;
            document.getElementById('stopMonitoring').disabled = true;
        });
    });
});
