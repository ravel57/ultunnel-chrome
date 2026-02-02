chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ enabled: false, proxy: {} });
});

chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) updateProxy(changes.enabled.newValue);
});

function updateProxy(enabled) {
    chrome.storage.local.get('proxy', ({ proxy }) => {
        if (!enabled || !proxy.host || !proxy.port) {
            chrome.proxy.settings.clear({ scope: 'regular' });
            return;
        }

        const config = {
            mode: 'fixed_servers',
            rules: {
                singleProxy: {
                    scheme: 'socks5',
                    host: proxy.host,
                    port: parseInt(proxy.port)
                },
                bypassList: ['<local>']
            }
        };

        chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
            console.log('SOCKS5 proxy enabled:', proxy.host + ':' + proxy.port);
        });

        // Chrome сам покажет окно ввода логина/пароля при первом соединении.
        // Пользователь введёт их — Chrome сохранит в памяти.
    });
}
