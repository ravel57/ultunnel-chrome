// background.js (MV3)
// Modes:
// 1) tunnelAll=true  => fixed_servers SOCKS5 127.0.0.1:5613 for ALL traffic
// 2) tunnelAll=false => PAC: SOCKS5 only for domains in list, otherwise DIRECT
//
// Storage:
// - tunnelAll: boolean
// - domains: string[]  (rules; match host == rule OR host endsWith "."+rule)

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 5613;

const STORAGE_KEYS = {
	tunnelAll: "tunnelAll",
	domains: "domains",
};

function normalizeDomain(d) {
	return String(d || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function stripWww(host) {
	const h = normalizeDomain(host);
	return h.startsWith("www.") ? h.substring(4) : h;
}

function uniqueSorted(arr) {
	return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

// Collapse rotating CDN hosts to base domains (YouTube)
function collapseHostnameForRules(hostname) {
	const h = normalizeDomain(hostname);
	if (!h) return "";
	if (h === "googlevideo.com" || h.endsWith(".googlevideo.com")) return "googlevideo.com";
	if (h === "ytimg.com" || h.endsWith(".ytimg.com")) return "ytimg.com";
	if (h === "youtube.com" || h.endsWith(".youtube.com")) return "youtube.com";
	return h;
}

function buildPac(domains) {
	const domainsJson = JSON.stringify(domains);

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

function getHostFromUrl(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function isHostCovered(host, rules) {
	const h = normalizeDomain(host);
	if (!h) return false;
	for (const r of rules) {
		const rr = normalizeDomain(r);
		if (!rr) continue;
		if (h === rr) return true;
		if (h.endsWith("." + rr)) return true;
	}
	return false;
}

function presetsForHost(host) {
	const h = normalizeDomain(host);

	// YouTube presets (covers googlevideo/ytimg/etc.)
	if (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be")) {
		return ["youtube.com", "ytimg.com", "googlevideo.com", "youtubei.googleapis.com", "ggpht.com"];
	}

	// Instagram presets (commonly required)
	if (h === "instagram.com" || h.endsWith(".instagram.com")) {
		return ["instagram.com", "cdninstagram.com", "fbcdn.net", "facebook.com", "graph.facebook.com"];
	}

	return [];
}

async function getState() {
	const data = await chrome.storage.local.get([STORAGE_KEYS.tunnelAll, STORAGE_KEYS.domains]);
	return {
		tunnelAll: !!data[STORAGE_KEYS.tunnelAll],
		domains: Array.isArray(data[STORAGE_KEYS.domains]) ? data[STORAGE_KEYS.domains] : [],
	};
}

async function applyProxy() {
	const { tunnelAll, domains } = await getState();

	if (tunnelAll) {
		const config = {
			mode: "fixed_servers",
			rules: {
				singleProxy: { scheme: "socks5", host: PROXY_HOST, port: PROXY_PORT },
				bypassList: ["<local>"],
			},
		};
		chrome.proxy.settings.set({ value: config, scope: "regular" });
		return;
	}

	const clean = uniqueSorted(domains.map(normalizeDomain).filter(Boolean));
	if (clean.length === 0) {
		chrome.proxy.settings.clear({ scope: "regular" });
		return;
	}

	const pac = buildPac(clean);
	chrome.proxy.settings.set({
		value: { mode: "pac_script", pacScript: { data: pac } },
		scope: "regular",
	});
}

chrome.runtime.onInstalled.addListener(async () => {
	const data = await chrome.storage.local.get([STORAGE_KEYS.tunnelAll, STORAGE_KEYS.domains]);
	const patch = {};
	if (typeof data[STORAGE_KEYS.tunnelAll] !== "boolean") patch[STORAGE_KEYS.tunnelAll] = false;
	if (!Array.isArray(data[STORAGE_KEYS.domains])) patch[STORAGE_KEYS.domains] = [];
	if (Object.keys(patch).length) await chrome.storage.local.set(patch);
	await applyProxy();
});

chrome.runtime.onStartup.addListener(async () => {
	await applyProxy();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
	if (area !== "local") return;
	if (changes[STORAGE_KEYS.tunnelAll] || changes[STORAGE_KEYS.domains]) {
		await applyProxy();
	}
});

// Messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	(async () => {
		try {
			if (!msg?.type) return sendResponse({ ok: false });

			if (msg.type === "getPopupState") {
				const { tunnelAll, domains } = await getState();
				const url = String(msg.url || "");
				const host = getHostFromUrl(url);
				const siteRule = collapseHostnameForRules(stripWww(host));
				const siteEnabled = isHostCovered(siteRule, domains);
				return sendResponse({
					ok: true,
					tunnelAll,
					host,
					siteRule,
					siteEnabled,
					target: `${PROXY_HOST}:${PROXY_PORT}`,
				});
			}

			if (msg.type === "setTunnelAll") {
				await chrome.storage.local.set({ [STORAGE_KEYS.tunnelAll]: !!msg.value });
				await applyProxy();
				return sendResponse({ ok: true });
			}

			if (msg.type === "setSiteEnabled") {
				const { tunnelAll, domains } = await getState();
				if (tunnelAll) {
					// In global mode site toggle is irrelevant
					return sendResponse({ ok: true, ignored: true });
				}

				const host = normalizeDomain(msg.host || "");
				if (!host) return sendResponse({ ok: false, error: "empty_host" });

				const base = collapseHostnameForRules(stripWww(host));
				const enable = !!msg.value;

				let next = domains.map(normalizeDomain).filter(Boolean);

				if (enable) {
					const preset = presetsForHost(base);
					if (preset.length) next = next.concat(preset);
					else next.push(base);
				} else {
					// remove base + known presets if applicable
					const preset = presetsForHost(base);
					const toRemove = new Set([base, ...preset].map(normalizeDomain));
					next = next.filter((d) => !toRemove.has(normalizeDomain(d)));
				}

				next = uniqueSorted(next);

				await chrome.storage.local.set({ [STORAGE_KEYS.domains]: next });
				await applyProxy();

				return sendResponse({ ok: true, domains: next, siteEnabled: enable, siteRule: base });
			}

			return sendResponse({ ok: false, error: "unknown_type" });
		} catch (e) {
			return sendResponse({ ok: false, error: String(e?.message || e) });
		}
	})();

	return true;
});
