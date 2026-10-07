'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyPlatform,
  extractSupportedLinks,
  normalizeSupportedUrl
} = require('../src/lib/link-parser');

test('classifies only official TikTok domains', () => {
  assert.equal(classifyPlatform('www.tiktok.com'), 'tiktok');
  assert.equal(classifyPlatform('vm.tiktok.com'), 'tiktok');
  assert.equal(classifyPlatform('vt.tiktok.com'), 'tiktok');
  assert.equal(classifyPlatform('www.douyin.com'), null);
  assert.equal(classifyPlatform('fake-tiktok.com'), null);
  assert.equal(classifyPlatform('tiktok.com.evil.example'), null);
});

test('extracts TikTok links from share text and strips punctuation', () => {
  const result = extractSupportedLinks(
    'TikTok: https://www.tiktok.com/@demo/video/7421234567890123456?is_from_webapp=1。'
  );

  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].platform, 'tiktok');
  assert.equal(result.links[0].videoId, '7421234567890123456');
  assert.equal(result.invalidCount, 0);
});

test('accepts canonical and official TikTok short video URLs', () => {
  const samples = [
    'https://www.tiktok.com/@demo/video/7421234567890123456',
    'https://vm.tiktok.com/ZM123AbCd/',
    'https://vt.tiktok.com/ZM123AbCd/',
    'https://www.tiktok.com/t/ZM123AbCd/',
    'https://www.tiktok.com/share/video/7421234567890123456/'
  ];

  for (const url of samples) assert.equal(normalizeSupportedUrl(url)?.platform, 'tiktok', url);
});

test('canonicalizes a known TikTok item ID', () => {
  const modal = normalizeSupportedUrl('https://www.tiktok.com/?item_id=7421234567890123456&from=search');
  assert.equal(modal.url, 'https://www.tiktok.com/@_/video/7421234567890123456');
  assert.equal(modal.key, 'tiktok:7421234567890123456');
});

test('rejects profiles, feeds, Douyin, unrelated URLs, and lookalike domains', () => {
  const samples = [
    'https://www.tiktok.com/@demo',
    'https://www.tiktok.com/foryou',
    'https://www.tiktok.com/live',
    'https://www.douyin.com/video/7421234567890123456',
    'https://tiktok.com.evil.example/@demo/video/7421234567890123456',
    'https://example.com/video/7421234567890123456'
  ];

  for (const url of samples) assert.equal(normalizeSupportedUrl(url), null, url);
});

test('deduplicates the same TikTok video across tracking URLs and creators', () => {
  const result = extractSupportedLinks([
    'https://www.tiktok.com/@demo/video/7421234567890123456?is_from_webapp=1',
    'https://www.tiktok.com/@other/video/7421234567890123456?_r=1'
  ].join('\n'));
  assert.equal(result.links.length, 1);
  assert.equal(result.duplicateInInput, 1);
});

test('reports non-link input as invalid once', () => {
  const result = extractSupportedLinks('这里没有 TikTok 视频链接');
  assert.equal(result.links.length, 0);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.foundCount, 0);
});
