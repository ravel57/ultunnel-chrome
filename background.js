// background.js (MV3 service worker)
// 1) PAC auto-switch by domain list
// 2) Auto-learn domains from ALL tab requests (Chrome webRequest) and add to tunnel list
// Hardcoded proxy: SOCKS5 127.0.0.1:56130

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 56130;

const STORAGE_KEYS = {
	enabled: "enabled",     // boolean: use PAC or clear proxy
	domains: "domains",     // string[]
	autoLearn: "autoLearn", // boolean: auto-add domains from tab requests
};

const LIMIT_DOMAINS = 5000; // safety cap

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

	return `
var __DOMAINS__ = ${domainsJson};

function __isDomainMatch(host, domain) {
  if (!host || !domain) return false;
  host = host.toLowerCase();
  domain = domain.toLowerCase();
  return host === domain || shExpMatch(host, "*." + domain);
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
    if (__isDomainMatch(host, __DOMAINS__[i])) {
      return "SOCKS5 ${PROXY_HOST}:${PROXY_PORT}";
    }
  }

  return "DIRECT";
}
`.trim();
}

async function getState() {
	const data = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.domains, STORAGE_KEYS.autoLearn]);
	const enabled = typeof data[STORAGE_KEYS.enabled] === "boolean" ? data[STORAGE_KEYS.enabled] : true;
	const autoLearn = typeof data[STORAGE_KEYS.autoLearn] === "boolean" ? data[STORAGE_KEYS.autoLearn] : true;
	const domains = Array.isArray(data[STORAGE_KEYS.domains]) ? data[STORAGE_KEYS.domains] : [];
	return {enabled, domains, autoLearn};
}

async function setDefaultsIfMissing() {
	const data = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.domains, STORAGE_KEYS.autoLearn]);
	const next = {};
	if (typeof data[STORAGE_KEYS.enabled] !== "boolean") next[STORAGE_KEYS.enabled] = true;
	if (!Array.isArray(data[STORAGE_KEYS.domains])) next[STORAGE_KEYS.domains] = [];
	if (typeof data[STORAGE_KEYS.autoLearn] !== "boolean") next[STORAGE_KEYS.autoLearn] = true;
	if (Object.keys(next).length) await chrome.storage.local.set(next);
}

async function applyProxy() {
	const {enabled, domains} = await getState();

	if (!enabled || !domains.length) {
		chrome.proxy.settings.clear({scope: "regular"});
		return;
	}

	const pac = buildPac(domains);
	chrome.proxy.settings.set({
		value: {mode: "pac_script", pacScript: {data: pac}},
		scope: "regular",
	});
}

// ---- batching (avoid writing/applying on every request) ----
let memDomains = new Set();
let flushTimer = null;

async function initMemDomains() {
	const {domains} = await getState();
	memDomains = new Set((domains || []).map(normalizeDomain).filter(Boolean));
}

function scheduleFlush() {
	if (flushTimer) return;
	flushTimer = setTimeout(async () => {
		flushTimer = null;
		const next = uniqueSorted(Array.from(memDomains)).slice(0, LIMIT_DOMAINS);
		await chrome.storage.local.set({[STORAGE_KEYS.domains]: next});
		// applyProxy will be triggered by storage.onChanged, но пусть будет и тут (на случай редких гонок)
		await applyProxy();
	}, 1000);
}

function addLearnedDomain(hostname) {
	const d = normalizeDomain(hostname);
	if (!d) return;

	// не добавляем мусор
	if (d === "localhost") return;

	if (!memDomains.has(d)) {
		memDomains.add(d);

		// cap in-memory too
		if (memDomains.size > LIMIT_DOMAINS) {
			// грубо урезаем (детерминированно): оставляем первые LIMIT_DOMAINS в сортировке
			memDomains = new Set(uniqueSorted(Array.from(memDomains)).slice(0, LIMIT_DOMAINS));
		}

		scheduleFlush();
	}
}

// ---- learn from tab requests ----
function onBeforeRequest(details) {
	// tabId >= 0 => request belongs to a tab
	if (typeof details.tabId !== "number" || details.tabId < 0) return;

	let url;
	try {
		url = new URL(details.url);
	} catch {
		return;
	}

	// Only tunnel network schemes we care about
	if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
		return;
	}

	addLearnedDomain(url.hostname);
}

// ---- lifecycle ----
chrome.runtime.onInstalled.addListener(async () => {
	await setDefaultsIfMissing();
	await initMemDomains();
	await applyProxy();
});

chrome.runtime.onStartup.addListener(async () => {
	await setDefaultsIfMissing();
	await initMemDomains();
	await applyProxy();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
	if (area !== "local") return;

	// keep memDomains synced if domains changed externally
	if (changes[STORAGE_KEYS.domains]) {
		const next = Array.isArray(changes[STORAGE_KEYS.domains].newValue) ? changes[STORAGE_KEYS.domains].newValue : [];
		memDomains = new Set(next.map(normalizeDomain).filter(Boolean));
	}

	if (changes[STORAGE_KEYS.enabled] || changes[STORAGE_KEYS.domains]) {
		await applyProxy();
	}
});

// register listener once
chrome.webRequest.onBeforeRequest.addListener(
	onBeforeRequest,
	{urls: ["<all_urls>"]}
);

// ---- messages (optional: for popup) ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	(async () => {
		if (!msg || typeof msg.type !== "string") return sendResponse({ok: false});

		if (msg.type === "getState") {
			const s = await getState();
			return sendResponse({
				ok: true,
				enabled: s.enabled,
				autoLearn: s.autoLearn,
				domainsCount: s.domains.length,
				target: `${PROXY_HOST}:${PROXY_PORT}`,
			});
		}

		if (msg.type === "setEnabled") {
			await chrome.storage.local.set({[STORAGE_KEYS.enabled]: !!msg.enabled});
			return sendResponse({ok: true});
		}

		if (msg.type === "setAutoLearn") {
			await chrome.storage.local.set({[STORAGE_KEYS.autoLearn]: !!msg.autoLearn});
			return sendResponse({ok: true});
		}

		if (msg.type === "clearDomains") {
			memDomains = new Set();
			await chrome.storage.local.set({[STORAGE_KEYS.domains]: []});
			await applyProxy();
			return sendResponse({ok: true});
		}

		return sendResponse({ok: false, error: "unknown_type"});
	})();

	return true;
});
