const saveBtn = document.getElementById('save');
const toggleBtn = document.getElementById('toggle');

chrome.storage.local.get(['proxy', 'enabled'], data => {
    const { proxy = {}, enabled = false } = data;
    document.getElementById('host').value = proxy.host || '';
    document.getElementById('port').value = proxy.port || '';
    document.getElementById('user').value = proxy.user || '';
    document.getElementById('pass').value = proxy.pass || '';
    toggleBtn.textContent = enabled ? 'Выключить' : 'Включить';
    toggleBtn.className = enabled ? 'off' : '';
});

saveBtn.onclick = () => {
    const proxy = {
        host: document.getElementById('host').value.trim(),
        port: parseInt(document.getElementById('port').value),
        user: document.getElementById('user').value.trim(),
        pass: document.getElementById('pass').value.trim()
    };
    chrome.storage.local.set({ proxy });
};

toggleBtn.onclick = () => {
    chrome.storage.local.get('enabled', ({ enabled }) => {
        chrome.storage.local.set({ enabled: !enabled });
    });
};
