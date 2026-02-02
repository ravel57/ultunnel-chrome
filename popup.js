const api = chrome;

function $(id) {
	return document.getElementById(id);
}

async function getActiveTab() {
	const [tab] = await api.tabs.query({active: true, currentWindow: true});
	return tab;
}

function getHostname(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function isHostCovered(host, domains) {
	if (!host) return false;
	for (const d of domains) {
		if (host === d) return true;
		if (host.endsWith("." + d)) return true;
	}
	return false;
}

function renderDomains(domains) {
	const root = $("domains");
	root.innerHTML = "";
	if (!domains.length) {
		root.innerHTML = `<div class="hint">Список пуст.</div>`;
		return;
	}
	for (const d of domains) {
		const row = document.createElement("div");
		row.className = "domainRow";

		const name = document.createElement("div");
		name.className = "domainName";
		name.title = d;
		name.textContent = d;

		const btn = document.createElement("button");
		btn.className = "btn";
		btn.textContent = "Удалить";
		btn.onclick = async () => {
			const res = await api.runtime.sendMessage({type: "removeDomain", domain: d});
			if (res?.ok) renderDomains(res.domains || []);
		};

		row.appendChild(name);
		row.appendChild(btn);
		root.appendChild(row);
	}
}

document.addEventListener("DOMContentLoaded", async () => {
	const siteToggle = $("siteToggle");
	const globalToggle = $("globalToggle");
	const clearBtn = $("clearBtn");
	const hint = $("hint");

	const tab = await getActiveTab();
	const host = getHostname(tab?.url || "");

	$("siteInfo").textContent = host ? `Сайт: ${host}` : "Сайт: неизвестно (chrome:// и т.п.)";

	const state = await api.runtime.sendMessage({type: "getState"});
	if (!state?.ok) {
		hint.textContent = "Не удалось получить состояние расширения.";
		siteToggle.disabled = true;
		globalToggle.disabled = true;
		return;
	}

	globalToggle.checked = !!state.enabled;
	$("globalInfo").textContent = `SOCKS5 ${state.target}. Проксируются только домены из списка.`;

	renderDomains(state.domains || []);
	siteToggle.checked = isHostCovered(host, state.domains || []);

	if (!host) {
		siteToggle.disabled = true;
		hint.textContent = "На этой вкладке нельзя определить домен.";
	} else {
		hint.textContent = "";
	}

	globalToggle.addEventListener("change", async () => {
		await api.runtime.sendMessage({type: "setEnabled", enabled: globalToggle.checked});
	});

	siteToggle.addEventListener("change", async () => {
		if (!host) return;
		const res = await api.runtime.sendMessage({
			type: "setDomainEnabled",
			domain: host,
			enabled: siteToggle.checked
		});
		if (res?.ok) renderDomains(res.domains || []);
	});

	clearBtn.addEventListener("click", async () => {
		const res = await api.runtime.sendMessage({type: "clearDomains"});
		if (res?.ok) {
			renderDomains([]);
			siteToggle.checked = false;
		}
	});
});
