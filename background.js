// background.js (MV3 service worker)
// Auto-switch proxy by domain list (PAC), like SwitchyOmega.
// Hardcoded proxy: SOCKS5 127.0.0.1:56130

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 56130;

const STORAGE_KEYS = {
    enabled: "enabled",
    domains: "domains", // string[]
};

function normalizeDomain(d) {
    return String(d || "")
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, ""); // trim dots
}

function uniqueSorted(arr) {
    return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

function buildPac(domains) {
    // domains: ["example.com", "sub.site.org"]
    // Match rule: host == domain OR host endsWith("." + domain)
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

  // Bypass local stuff
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
    const data = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.domains]);
    const enabled = !!data[STORAGE_KEYS.enabled];
    const domains = Array.isArray(data[STORAGE_KEYS.domains]) ? data[STORAGE_KEYS.domains] : [];
    return { enabled, domains };
}

async function applyProxy() {
    const { enabled, domains } = await getState();

    if (!enabled || domains.length === 0) {
        chrome.proxy.settings.clear({ scope: "regular" });
        return;
    }

    const pac = buildPac(domains);

    const config = {
        mode: "pac_script",
        pacScript: { data: pac },
    };

    chrome.proxy.settings.set({ value: config, scope: "regular" });
}

async function initDefaults() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.enabled, STORAGE_KEYS.domains]);
    const next = {};
    if (typeof data[STORAGE_KEYS.enabled] !== "boolean") next[STORAGE_KEYS.enabled] = true;
    if (!Array.isArray(data[STORAGE_KEYS.domains])) next[STORAGE_KEYS.domains] = [];
    if (Object.keys(next).length) await chrome.storage.local.set(next);
}

// Install / startup
chrome.runtime.onInstalled.addListener(() => {
    initDefaults().then(applyProxy);
});
chrome.runtime.onStartup.addListener(() => {
    applyProxy();
});

// React on storage changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEYS.enabled] || changes[STORAGE_KEYS.domains]) {
        applyProxy();
    }
});

// Messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        try {
            if (!msg || typeof msg.type !== "string") return sendResponse({ ok: false });

            if (msg.type === "getState") {
                const { enabled, domains } = await getState();
                return sendResponse({
                    ok: true,
                    enabled,
                    domains,
                    target: `${PROXY_HOST}:${PROXY_PORT}`,
                });
            }

            if (msg.type === "setEnabled") {
                await chrome.storage.local.set({ [STORAGE_KEYS.enabled]: !!msg.enabled });
                return sendResponse({ ok: true });
            }

            if (msg.type === "addDomain") {
                const { domains } = await getState();
                const d = normalizeDomain(msg.domain);
                if (!d) return sendResponse({ ok: false, error: "empty_domain" });

                const next = uniqueSorted([...domains.map(normalizeDomain).filter(Boolean), d]);
                await chrome.storage.local.set({ [STORAGE_KEYS.domains]: next });
                return sendResponse({ ok: true, domains: next });
            }

            if (msg.type === "removeDomain") {
                const { domains } = await getState();
                const d = normalizeDomain(msg.domain);
                const next = domains.map(normalizeDomain).filter(x => x && x !== d);
                await chrome.storage.local.set({ [STORAGE_KEYS.domains]: next });
                return sendResponse({ ok: true, domains: next });
            }

            if (msg.type === "setDomainEnabled") {
                // enabled=true => add, enabled=false => remove
                const { domains } = await getState();
                const d = normalizeDomain(msg.domain);
                if (!d) return sendResponse({ ok: false, error: "empty_domain" });

                let next;
                if (msg.enabled) {
                    next = uniqueSorted([...domains.map(normalizeDomain).filter(Boolean), d]);
                } else {
                    next = domains.map(normalizeDomain).filter(x => x && x !== d);
                }
                await chrome.storage.local.set({ [STORAGE_KEYS.domains]: next });
                return sendResponse({ ok: true, domains: next });
            }

            return sendResponse({ ok: false, error: "unknown_type" });
        } catch (e) {
            return sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
    })();

    return true; // keep the channel open for async
});
