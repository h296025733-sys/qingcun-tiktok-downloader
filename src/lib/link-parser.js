'use strict';

const TRAILING_PUNCTUATION = /[\])}>\u3009\u300b\u300d\u300f\u3011\u3015\u3017\u3019\u301b.,;:!?，。；：！？、'"’”]+$/u;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

function isSubdomainOf(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function classifyPlatform(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return isSubdomainOf(host, 'tiktok.com') ? 'tiktok' : null;
}

function isLikelySingleVideo(parsed) {
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return pathname.length > 1;
  return (
    /\/@[^/]+\/video\/\d{8,}(?:\/|$)/i.test(pathname) ||
    /\/(?:t|share\/video)\/[A-Za-z0-9_-]+(?:\/|$)/i.test(pathname) ||
    /^\d{8,}$/.test(parsed.searchParams.get('item_id') || '')
  );
}

function cleanRawUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(TRAILING_PUNCTUATION, '');
}

function normalizeSupportedUrl(raw) {
  const cleaned = cleanRawUrl(raw);
  if (!cleaned || cleaned.length > 4096) return null;

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch (_error) {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (classifyPlatform(parsed.hostname) !== 'tiktok' || !isLikelySingleVideo(parsed)) return null;

  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';

  const videoId = extractVideoId(parsed);
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '') || '/'}${videoId ? '' : normalizedEssentialQuery(parsed)}`;
  const downloadUrl = videoId && !/\/@[^/]+\/video\//i.test(parsed.pathname)
    ? `https://www.tiktok.com/@_/video/${videoId}`
    : parsed.href;

  return {
    url: downloadUrl,
    normalized,
    platform: 'tiktok',
    videoId,
    key: videoId ? `tiktok:${videoId}` : `tiktok:${normalized}`
  };
}

function normalizedEssentialQuery(parsed) {
  const value = parsed.searchParams.get('item_id');
  return value ? `?item_id=${encodeURIComponent(value)}` : '';
}

function extractVideoId(parsed) {
  for (const pattern of [/\/@[^/]+\/video\/(\d{8,})(?:\/|$)/i, /\/share\/video\/(\d{8,})(?:\/|$)/i]) {
    const match = parsed.pathname.match(pattern);
    if (match) return match[1];
  }

  const queryId = parsed.searchParams.get('item_id');
  return /^\d{8,}$/.test(queryId || '') ? queryId : '';
}

function extractSupportedLinks(text) {
  const rawText = String(text || '');
  const matches = rawText.match(URL_PATTERN) || [];
  const accepted = [];
  const seen = new Set();
  let invalidCount = 0;
  let duplicateInInput = 0;

  for (const raw of matches) {
    const link = normalizeSupportedUrl(raw);
    if (!link) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(link.key)) {
      duplicateInInput += 1;
      continue;
    }
    seen.add(link.key);
    accepted.push(link);
  }

  if (!matches.length && rawText.trim()) invalidCount = 1;

  return {
    links: accepted,
    foundCount: matches.length,
    invalidCount,
    duplicateInInput
  };
}

module.exports = {
  classifyPlatform,
  extractSupportedLinks,
  extractVideoId,
  isLikelySingleVideo,
  normalizeSupportedUrl
};
