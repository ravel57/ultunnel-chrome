const api = chrome;

function $(id) { return document.getElementById(id); }

function setHint(text) {
    const el = $("hint");
    if (!text) { el.classList.add("hidden"); el.textContent = ""; return; }
    el.classList.remove("hidden");
    el.textContent = text;
}

async function getActiveTab() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab;
}

function getHostname(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function renderDomains(domains, currentHost) {
    const root = $("domains");
    root.innerHTML = "";

    if (!domains || domains.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "Список пуст. Включайте VPN на нужном сайте сверху.";
        root.appendChild(empty);
        return;
    }

    for (const d of domains) {
        const row = document.createElement("div");
        row.className = "domainRow";

        const name = document.createElement("div");
        name.className = "domainName";
        name.title = d;
        name.textContent = d + (currentHost && (currentHost === d || currentHost.endsWith("." + d)) ? " (текущий)" : "");

        const btn = document.createElement("button");
        btn.className = "btn";
        btn.textContent = "Удалить";
        btn.onclick = async () => {
            const res = await api.runtime.sendMessage({ type: "removeDomain", domain: d });
            if (res && res.ok) {
                renderDomains(res.domains || [], currentHost);
                // обновим переключатель для текущего сайта
                await refreshCurrentSiteToggle(currentHost, res.domains || []);
            }
        };

        row.appendChild(name);
        row.appendChild(btn);
        root.appendChild(row);
    }
}

function isHostCoveredByDomains(host, domains) {
    if (!host) return false;
    for (const d of domains) {
        if (host === d || host.endsWith("." + d)) return true;
    }
    return false;
}

async function refreshCurrentSiteToggle(host, domains) {
    const siteToggle = $("siteToggle");
    siteToggle.checked = isHostCoveredByDomains(host, domains);
}

document.addEventListener("DOMContentLoaded", async () => {
    const siteToggle = $("siteToggle");
    const globalToggle = $("globalToggle");

    const tab = await getActiveTab();
    const host = getHostname(tab && tab.url ? tab.url : "");
    $("siteInfo").textContent = host ? `Сайт: ${host}` : "Сайт: неизвестно";
    $("globalInfo").textContent = "Прокси: SOCKS5 127.0.0.1:56130";

    const state = await api.runtime.sendMessage({ type: "getState" });
    if (!state || !state.ok) {
        setHint("Не удалось получить состояние расширения.");
        siteToggle.disabled = true;
        globalToggle.disabled = true;
        return;
    }

    globalToggle.checked = !!state.enabled;
    renderDomains(state.domains || [], host);
    await refreshCurrentSiteToggle(host, state.domains || []);

    // Если URL недоступен (chrome://, extensions, новый таб) — нельзя понять домен
    if (!host) {
        siteToggle.disabled = true;
        setHint("На этой вкладке нельзя определить домен (например, chrome://).");
    } else {
        setHint(null);
    }

    globalToggle.addEventListener("change", async () => {
        await api.runtime.sendMessage({ type: "setEnabled", enabled: globalToggle.checked });
    });

    siteToggle.addEventListener("change", async () => {
        if (!host) return;
        const res = await api.runtime.sendMessage({
            type: "setDomainEnabled",
            domain: host,
            enabled: siteToggle.checked
        });

        if (res && res.ok) {
            renderDomains(res.domains || [], host);
            await refreshCurrentSiteToggle(host, res.domains || []);
        }
    });
});
