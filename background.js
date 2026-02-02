// background.js (MV3)
// Manual domain list -> PAC -> SOCKS5 127.0.0.1:56130 ONLY for listed domains

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 56130;

const STORAGE_KEYS = {
	enabled: "enabled",   // boolean
	domains: "domains",   // string[]
};

function normalizeDomain(d) {
	return String(d || "")
		.trim()
		.toLowerCase()
		.replace(/^\.+|\.+$/g, "");
}

function uniqueSorted(arr) {
	return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

function buildPac(domains) {
	const domainsJson = JSON.stringify(domains);

	// IMPORTANT: match host == domain OR host ends with "." + domain
	// Do NOT use patterns that can match everything.
	return `
var __DOMAINS__ = ${domainsJson};

function __endsWithDomain(host, domain) {
  host = (host || "").toLowerCase();
  domain = (domain || "").toLowerCase();
  if (!host || !domain) return false;
  if (host === domain) return true;

  var suffix = "." + domain;
  if (host.length <= suffix.length) return false;
  return host.substring(host.length - suffix.length) === suffix;
}

function FindProxyForURL(url, host) {
  if (!host) return "DIRECT";

  // Bypass local/private
  if (isPlainHostName(host)) return "DIRECT";
  if (dnsDomainIs(host, "localhost") || shExpMatch(host, "localhost.*")) return "DIRECT";
  if (isInNet(host, "127.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "172.16.0.0", "255.240.0.0")) return "DIRECT";
  if (isInNet(host, "192.168.0.0", "255.255.0.0")) return "DIRECT";

  for (var i = 0; i < __DOMAINS__.length; i++) {
    if (__endsWithDomain(host, __DOMAINS__[i])) {
      return "SOCKS5 ${PROXY_HOST}:${PROXY_PORT}";
    }
  }

  return "DIRECT";
}
`.trim();
}

async function getState() {
	const data = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.domains]);
	const enabled = typeof data[STORAGE_KEYS.enabled] === "boolean" ? data[STORAGE_KEYS.enabled] : true;
	const domains = Array.isArray(data[STORAGE_KEYS.domains]) ? data[STORAGE_KEYS.domains] : [];
	return { enabled, domains };
}

async function setDefaultsIfMissing() {
	const data = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.domains]);
	const next = {};
	if (typeof data[STORAGE_KEYS.enabled] !== "boolean") next[STORAGE_KEYS.enabled] = true;
	if (!Array.isArray(data[STORAGE_KEYS.domains])) next[STORAGE_KEYS.domains] = [];
	if (Object.keys(next).length) await chrome.storage.local.set(next);
}

async function applyProxy() {
	const { enabled, domains } = await getState();

	// If выключено или список пуст -> вообще не трогаем прокси (DIRECT)
	if (!enabled || domains.length === 0) {
		chrome.proxy.settings.clear({ scope: "regular" });
		return;
	}

	const pac = buildPac(domains.map(normalizeDomain).filter(Boolean));
	chrome.proxy.settings.set({
		value: { mode: "pac_script", pacScript: { data: pac } },
		scope: "regular",
	});
}

// lifecycle
chrome.runtime.onInstalled.addListener(async () => {
	await setDefaultsIfMissing();
	await applyProxy();
});
chrome.runtime.onStartup.addListener(async () => {
	await setDefaultsIfMissing();
	await applyProxy();
});

// react to changes
chrome.storage.onChanged.addListener(async (changes, area) => {
	if (area !== "local") return;
	if (changes[STORAGE_KEYS.enabled] || changes[STORAGE_KEYS.domains]) {
		await applyProxy();
	}
});

// messages
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	(async () => {
		try {
			if (!msg || typeof msg.type !== "string") return sendResponse({ ok: false });

			if (msg.type === "getState") {
				const { enabled, domains } = await getState();
				return sendResponse({ ok: true, enabled, domains, target: `${PROXY_HOST}:${PROXY_PORT}` });
			}

			if (msg.type === "setEnabled") {
				await chrome.storage.local.set({ [STORAGE_KEYS.enabled]: !!msg.enabled });
				return sendResponse({ ok: true });
			}

			if (msg.type === "setDomainEnabled") {
				const d = normalizeDomain(msg.domain);
				if (!d) return sendResponse({ ok: false, error: "empty_domain" });

				const { domains } = await getState();
				const norm = domains.map(normalizeDomain).filter(Boolean);

				let next;
				if (!!msg.enabled) next = uniqueSorted([...norm, d]);
				else next = norm.filter(x => x !== d);

				await chrome.storage.local.set({ [STORAGE_KEYS.domains]: next });
				return sendResponse({ ok: true, domains: next });
			}

			if (msg.type === "removeDomain") {
				const d = normalizeDomain(msg.domain);
				const { domains } = await getState();
				const next = domains.map(normalizeDomain).filter(x => x && x !== d);
				await chrome.storage.local.set({ [STORAGE_KEYS.domains]: next });
				return sendResponse({ ok: true, domains: next });
			}

			if (msg.type === "clearDomains") {
				await chrome.storage.local.set({ [STORAGE_KEYS.domains]: [] });
				return sendResponse({ ok: true, domains: [] });
			}

			return sendResponse({ ok: false, error: "unknown_type" });
		} catch (e) {
			return sendResponse({ ok: false, error: String(e?.message || e) });
		}
	})();

	return true;
});
