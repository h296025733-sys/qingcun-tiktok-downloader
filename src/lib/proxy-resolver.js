'use strict';

const PROXY_SCHEMES = new Map([
  ['PROXY', 'http:'],
  ['HTTP', 'http:'],
  ['HTTPS', 'https:'],
  ['SOCKS', 'socks4:'],
  ['SOCKS4', 'socks4:'],
  ['SOCKS5', 'socks5h:']
]);

function parseProxyDecision(decision) {
  const candidates = [];
  const parts = String(decision || '').split(';').map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) return [];

  for (const part of parts) {
    if (/^DIRECT$/i.test(part)) {
      pushUnique(candidates, '');
      continue;
    }

    const match = part.match(/^([A-Z0-9]+)\s+(.+)$/i);
    if (!match) return [];
    const scheme = PROXY_SCHEMES.get(match[1].toUpperCase());
    if (!scheme) return [];
    const proxyUrl = normalizeProxyUrl(scheme, match[2]);
    if (!proxyUrl) return [];
    pushUnique(candidates, proxyUrl);
  }

  return candidates.slice(0, 5);
}

function normalizeProxyUrl(protocol, address) {
  const value = String(address || '').trim();
  if (!value || /[\r\n\t]/.test(value)) return '';

  const authorityMatch = value.startsWith('[')
    ? value.match(/^(\[[0-9a-f:.]+\]):(\d+)$/i)
    : value.match(/^([^:/\\?#@\s]+):(\d+)$/);
  if (!authorityMatch) return '';
  const port = Number(authorityMatch[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';

  try {
    const parsed = new URL(`${protocol}//${value}`);
    if (parsed.protocol !== protocol || !parsed.hostname) return '';
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    if (parsed.pathname && parsed.pathname !== '/') return '';
    return `${protocol}//${parsed.hostname}:${port}`;
  } catch (_error) {
    return '';
  }
}

async function resolveSystemProxyCandidates(electronSession, targetUrl, timeoutMs = 5000) {
  if (!electronSession || typeof electronSession.resolveProxy !== 'function') return [];
  let timeoutHandle;
  try {
    const decision = await Promise.race([
      electronSession.resolveProxy(targetUrl),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('System proxy resolution timed out')), timeoutMs);
      })
    ]);
    return parseProxyDecision(decision);
  } catch (_error) {
    return [];
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

module.exports = {
  parseProxyDecision,
  resolveSystemProxyCandidates
};
