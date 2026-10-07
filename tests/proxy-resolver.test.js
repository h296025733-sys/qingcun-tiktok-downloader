'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProxyDecision, resolveSystemProxyCandidates } = require('../src/lib/proxy-resolver');

test('parses Windows and PAC proxy routes in their explicit order', () => {
  assert.deepEqual(
    parseProxyDecision('PROXY 127.0.0.1:7890; HTTPS secure.example:443; SOCKS5 127.0.0.1:1080; DIRECT'),
    ['http://127.0.0.1:7890', 'https://secure.example:443', 'socks5h://127.0.0.1:1080', '']
  );
  assert.deepEqual(parseProxyDecision('DIRECT'), ['']);
  assert.deepEqual(parseProxyDecision('SOCKS proxy.example:1080'), ['socks4://proxy.example:1080']);
  assert.deepEqual(parseProxyDecision('PROXY proxy.example:80; HTTPS secure.example:443'), [
    'http://proxy.example:80',
    'https://secure.example:443'
  ]);
});

test('rejects malformed, credential-bearing, and unsupported proxy routes', () => {
  assert.deepEqual(parseProxyDecision('PROXY user:pass@example.com:8080; QUIC host:443'), []);
  assert.deepEqual(parseProxyDecision('QUIC host:443; DIRECT'), []);
  assert.deepEqual(parseProxyDecision('PROXY user:pass@example.com:8080; DIRECT'), []);
  assert.deepEqual(parseProxyDecision('PROXY example.com:notaport'), []);
  assert.deepEqual(parseProxyDecision(''), []);
});

test('resolves Electron system proxy decisions and fails closed when resolution fails', async () => {
  assert.deepEqual(
    await resolveSystemProxyCandidates({ resolveProxy: async () => 'PROXY 127.0.0.1:9567' }, 'https://www.tiktok.com/'),
    ['http://127.0.0.1:9567']
  );
  assert.deepEqual(
    await resolveSystemProxyCandidates({ resolveProxy: async () => { throw new Error('PAC failed'); } }, 'https://www.tiktok.com/'),
    []
  );
  assert.deepEqual(await resolveSystemProxyCandidates(null, 'https://www.tiktok.com/'), []);
});
