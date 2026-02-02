const api = chrome;

function $(id) { return document.getElementById(id); }

async function getActiveTab() {
	const [tab] = await api.tabs.query({ active: true, currentWindow: true });
	return tab;
}

document.addEventListener("DOMContentLoaded", async () => {
	const allToggle = $("allToggle");
	const siteToggle = $("siteToggle");
	const allInfo = $("allInfo");
	const siteInfo = $("siteInfo");
	const siteBlock = $("siteBlock");
	const hint = $("hint");

	const tab = await getActiveTab();
	const url = tab?.url || "";

	const st = await api.runtime.sendMessage({ type: "getPopupState", url });
	if (!st?.ok) {
		hint.textContent = "Не удалось получить состояние.";
		allToggle.disabled = true;
		siteToggle.disabled = true;
		return;
	}

	allToggle.checked = !!st.tunnelAll;
	allInfo.textContent = `SOCKS5 ${st.target}`;

	if (!st.host) {
		siteToggle.disabled = true;
		siteInfo.textContent = "Сайт: неизвестно (chrome:// и т.п.)";
	} else {
		siteInfo.textContent = `Сайт: ${st.host}`;
	}

	function refreshUiGlobalMode() {
		if (allToggle.checked) {
			siteBlock.classList.add("disabled");
			hint.textContent = "Глобальный режим: туннелируется весь трафик браузера.";
		} else {
			siteBlock.classList.remove("disabled");
			hint.textContent = "";
		}
	}

	siteToggle.checked = !!st.siteEnabled;
	refreshUiGlobalMode();

	allToggle.addEventListener("change", async () => {
		const res = await api.runtime.sendMessage({ type: "setTunnelAll", value: allToggle.checked });
		if (!res?.ok) {
			// rollback
			allToggle.checked = !allToggle.checked;
			hint.textContent = "Не удалось переключить режим.";
			return;
		}
		refreshUiGlobalMode();
	});

	siteToggle.addEventListener("change", async () => {
		if (!st.host) return;

		const res = await api.runtime.sendMessage({
			type: "setSiteEnabled",
			host: st.host,
			value: siteToggle.checked
		});

		if (!res?.ok) {
			siteToggle.checked = !siteToggle.checked; // rollback
			hint.textContent = res?.error ? `Ошибка: ${res.error}` : "Не удалось переключить сайт.";
			return;
		}

		hint.textContent = "";
	});
});
