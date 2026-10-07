'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const {
  DownloadManager,
  buildYtDlpArgs,
  friendlyDownloadError,
  isRetryableProxyFailure,
  isPathInside,
  parseEngineLine,
  sanitizeTechnicalError
} = require('../src/lib/download-manager');

function createControlledSpawner() {
  const calls = [];
  const spawnProcess = (engine, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      if (child.killed) return false;
      child.killed = true;
      queueMicrotask(() => child.emit('close', 1));
      return true;
    };
    calls.push({ engine, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function testUrl(id) {
  return `https://www.tiktok.com/@demo/video/${id}`;
}

test('builds a locked-down single-video, no-watermark MP4 command', () => {
  const args = buildYtDlpArgs({
    downloadDirectory: 'D:\\Videos',
    url: 'https://www.tiktok.com/@demo/video/7421234567890123456'
  });
  const format = args[args.indexOf('--format') + 1];

  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-playlist'));
  assert.ok(args.includes('--no-overwrites'));
  assert.ok(args.includes('--progress-template'));
  assert.match(format, /format_id!\^=download/);
  assert.match(format, /watermarked/);
  assert.match(format, /vcodec!\*=bytevc2/);
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'https://www.tiktok.com/@demo/video/7421234567890123456');
});

test('passes an explicit PAC proxy route or DIRECT decision before the video URL', () => {
  const proxied = buildYtDlpArgs({
    downloadDirectory: 'D:\\Videos',
    url: testUrl('7421234567890123456'),
    proxyUrl: 'http://127.0.0.1:7890'
  });
  const direct = buildYtDlpArgs({
    downloadDirectory: 'D:\\Videos',
    url: testUrl('7421234567890123456'),
    proxyUrl: ''
  });

  assert.equal(proxied[proxied.indexOf('--proxy') + 1], 'http://127.0.0.1:7890');
  assert.ok(proxied.indexOf('--proxy') < proxied.indexOf('--'));
  assert.equal(direct[direct.indexOf('--proxy') + 1], '');
  assert.ok(direct.indexOf('--proxy') < direct.indexOf('--'));
});

test('parses machine-readable metadata, paths, and progress', () => {
  assert.deepEqual(parseEngineLine('__QC_TITLE__"标题 | 仍可解析"'), { type: 'title', value: '标题 | 仍可解析' });
  assert.deepEqual(parseEngineLine('__QC_FILE__"D:\\\\Videos\\\\视频.mp4"'), { type: 'file', value: 'D:\\Videos\\视频.mp4' });
  assert.deepEqual(
    parseEngineLine('__QC_PROGRESS__1024|4096|null|512|6|"downloading"'),
    {
      type: 'progress',
      downloadedBytes: 1024,
      totalBytes: 4096,
      speed: 512,
      eta: 6,
      status: 'downloading'
    }
  );
});

test('maps common native errors to concise Chinese messages', () => {
  assert.match(friendlyDownloadError('ERROR: Sign in or provide fresh cookies'), /登录或验证/);
  assert.match(friendlyDownloadError('ERROR: Requested format is not available'), /无水印 MP4/);
  assert.match(friendlyDownloadError('HTTP Error 429: Too Many Requests'), /请求过于频繁/);
  assert.match(friendlyDownloadError('ERROR: This video is private'), /私密/);
  assert.match(friendlyDownloadError('ProxyError: Unable to connect to proxy'), /系统代理无法连接/);
  assert.match(friendlyDownloadError('HTTP Error 407: Proxy Authentication Required'), /需要身份验证/);
  assert.match(friendlyDownloadError('getaddrinfo failed [WinError 11001]'), /无法解析 TikTok/);
  assert.match(friendlyDownloadError('certificate verify failed during TLS handshake'), /安全连接失败/);
  assert.match(friendlyDownloadError('operation timed out [WinError 10060]'), /连接 TikTok 超时/);
});

test('only retries explicit proxy establishment failures and redacts proxy endpoints', () => {
  assert.equal(isRetryableProxyFailure('ProxyError: Unable to connect to proxy'), true);
  assert.equal(isRetryableProxyFailure('curl: (7) Failed to connect to www.tiktok.com:443 over proxy 127.0.0.1'), true);
  assert.equal(isRetryableProxyFailure('HTTP Error 407: Proxy Authentication Required'), false);
  assert.equal(isRetryableProxyFailure('ProxyError: SOCKS5 authentication failed'), false);
  assert.equal(isRetryableProxyFailure('ProxyError: CONNECT failed with HTTP code 407'), false);
  assert.equal(isRetryableProxyFailure('CONNECT tunnel failed, response 407'), false);
  assert.equal(isRetryableProxyFailure('ProxyError: proxy login required'), false);
  assert.equal(isRetryableProxyFailure('HTTP Error 403: Forbidden'), false);
  assert.equal(isRetryableProxyFailure('operation timed out'), false);
  assert.doesNotMatch(
    sanitizeTechnicalError('Unable to connect over proxy 127.0.0.1:7890 via http://user:person0e2c5@example.com:8080'),
    /127\.0\.0\.1|proxy\.example|user:pass/
  );
  assert.doesNotMatch(
    sanitizeTechnicalError('HTTPS_PROXY=http://user:person0e2c5@example.com Unable to connect to proxy http://user:person0e2c5@example.com'),
    /proxy\.example|user:pass/
  );
});

test('validates final paths stay inside the selected directory', () => {
  const base = path.resolve('D:\\Downloads');
  assert.equal(isPathInside(base, path.join(base, 'video.mp4')), true);
  assert.equal(isPathInside(base, path.resolve(base, '..', 'outside.mp4')), false);
});

test('uses fixed concurrency and appends new tasks without disturbing active downloads', async () => {
  const spawner = createControlledSpawner();
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => 'D:\\Videos',
    concurrency: 2,
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });

  manager.addText([testUrl('7421234567890123451'), testUrl('7421234567890123452'), testUrl('7421234567890123453')].join('\n'));
  await waitFor(() => spawner.calls.length === 2);
  const firstTwoIds = manager.getState().tasks.slice(0, 2).map((task) => task.id);

  manager.addText(testUrl('7421234567890123454'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawner.calls.length, 2);
  assert.deepEqual(manager.getState().tasks.slice(0, 2).map((task) => task.id), firstTwoIds);

  const first = spawner.calls[0].child;
  first.stdout.write('__QC_TITLE__"第一个视频"\n');
  first.stdout.write('__QC_PROGRESS__512|1024|null|256|2|"downloading"\n');
  first.stdout.write('__QC_FILE__"D:\\\\Videos\\\\第一个视频.mp4"\n');
  first.stdout.end();
  first.stderr.end();
  first.emit('close', 0);

  await waitFor(() => spawner.calls.length === 3);
  const state = manager.getState();
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.tasks[0].progress, 100);
  assert.equal(state.tasks.filter((task) => task.status === 'starting').length, 2);
  assert.equal(state.tasks.filter((task) => task.status === 'queued').length, 1);
  manager.shutdown();
});

test('a failed task frees a slot and does not block the rest of the queue', async () => {
  const spawner = createControlledSpawner();
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => 'D:\\Videos',
    concurrency: 1,
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });

  manager.addText([testUrl('7421234567890123461'), testUrl('7421234567890123462')].join('\n'));
  await waitFor(() => spawner.calls.length === 1);
  spawner.calls[0].child.stderr.write('ERROR: HTTP Error 403: Forbidden\n');
  spawner.calls[0].child.stderr.end();
  spawner.calls[0].child.stdout.end();
  spawner.calls[0].child.emit('close', 1);

  await waitFor(() => spawner.calls.length === 2);
  const state = manager.getState();
  assert.equal(state.tasks[0].status, 'failed');
  assert.match(state.tasks[0].error, /拒绝访问/);
  assert.equal(state.tasks[1].status, 'starting');
  manager.shutdown();
});

test('follows only the proxy routes explicitly returned by PAC', async () => {
  const spawner = createControlledSpawner();
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => 'D:\\Videos',
    concurrency: 1,
    getProxyCandidates: async () => ['http://127.0.0.1:1', ''],
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });

  manager.addText(testUrl('7421234567890123491'));
  await waitFor(() => spawner.calls.length === 1);
  spawner.calls[0].child.stderr.write('ProxyError: Unable to connect to proxy 127.0.0.1:1\n');
  spawner.calls[0].child.stderr.end();
  spawner.calls[0].child.stdout.end();
  spawner.calls[0].child.emit('close', 1);

  await waitFor(() => spawner.calls.length === 2);
  assert.equal(spawner.calls[0].args[spawner.calls[0].args.indexOf('--proxy') + 1], 'http://127.0.0.1:1');
  assert.equal(spawner.calls[1].args[spawner.calls[1].args.indexOf('--proxy') + 1], '');
  const publicTask = manager.getState().tasks[0];
  assert.equal(Object.hasOwn(publicTask, 'proxyCandidates'), false);
  assert.equal(Object.hasOwn(manager.getPersistableTasks()[0], 'proxyCandidates'), false);
  manager.shutdown();
});

test('does not invent a direct fallback or retry proxy authentication failures', async () => {
  for (const error of [
    'ProxyError: Unable to connect to proxy 127.0.0.1:1',
    'HTTP Error 407: Proxy Authentication Required'
  ]) {
    const spawner = createControlledSpawner();
    const candidates = error.includes('407') ? ['http://127.0.0.1:1', ''] : ['http://127.0.0.1:1'];
    const manager = new DownloadManager({
      enginePath: 'yt-dlp.exe',
      getDownloadDirectory: () => 'D:\\Videos',
      concurrency: 1,
      getProxyCandidates: async () => candidates,
      spawnProcess: spawner.spawnProcess,
      accessDirectory: async () => {},
      fileIsValid: () => true
    });

    manager.addText(testUrl(error.includes('407') ? '7421234567890123492' : '7421234567890123493'));
    await waitFor(() => spawner.calls.length === 1);
    spawner.calls[0].child.stderr.end(`${error}\n`);
    spawner.calls[0].child.stdout.end();
    spawner.calls[0].child.emit('close', 1);
    await waitFor(() => manager.getState().tasks[0].status === 'failed');
    assert.equal(spawner.calls.length, 1);
    manager.shutdown();
  }
});

test('DIRECT first never switches to a later proxy after a direct network failure', async () => {
  const spawner = createControlledSpawner();
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => 'D:\\Videos',
    concurrency: 1,
    getProxyCandidates: async () => ['', 'http://127.0.0.1:1'],
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });

  manager.addText(testUrl('7421234567890123495'));
  await waitFor(() => spawner.calls.length === 1);
  spawner.calls[0].child.stderr.end('ProxyError: Unable to connect to proxy\n');
  spawner.calls[0].child.stdout.end();
  spawner.calls[0].child.emit('close', 1);
  await waitFor(() => manager.getState().tasks[0].status === 'failed');
  assert.equal(spawner.calls.length, 1);
  manager.shutdown();
});

test('fails without spawning when the Windows proxy decision cannot be resolved', async () => {
  const spawner = createControlledSpawner();
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => 'D:\\Videos',
    getProxyCandidates: async () => [],
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });

  manager.addText(testUrl('7421234567890123496'));
  await waitFor(() => manager.getState().tasks[0].status === 'failed');
  assert.equal(spawner.calls.length, 0);
  assert.match(manager.getState().tasks[0].error, /Windows 网络代理设置/);
});

test('canceling while Windows proxy resolution is pending never starts yt-dlp', async () => {
  const spawner = createControlledSpawner();
  let finishResolution;
  const pendingResolution = new Promise((resolve) => { finishResolution = resolve; });
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => 'D:\\Videos',
    concurrency: 1,
    getProxyCandidates: () => pendingResolution,
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });

  manager.addText(testUrl('7421234567890123494'));
  await waitFor(() => manager.getState().activeCount === 1);
  const task = manager.getState().tasks[0];
  assert.equal(manager.cancelTask(task.id), true);
  finishResolution(['']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawner.calls.length, 0);
  assert.equal(manager.getState().tasks[0].status, 'canceled');
});

test('queues tasks without prompting or starting until a directory exists', async () => {
  const spawner = createControlledSpawner();
  let directory = '';
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => directory,
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });

  const result = manager.addText(testUrl('7421234567890123471'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result.accepted, 1);
  assert.equal(spawner.calls.length, 0);
  assert.equal(manager.getState().tasks[0].status, 'queued');

  directory = 'D:\\Videos';
  manager.notifyDirectoryChanged();
  await waitFor(() => spawner.calls.length === 1);
  manager.shutdown();
});

test('drops legacy Douyin tasks when restoring the TikTok-only queue', () => {
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => '',
    initialTasks: [{
      id: 'legacy-douyin-task',
      url: 'https://www.douyin.com/video/7421234567890123456',
      status: 'failed',
      createdAt: Date.now()
    }]
  });

  assert.equal(manager.getState().tasks.length, 0);
});

test('redacts proxy credentials from restored failed-task diagnostics', () => {
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => '',
    initialTasks: [{
      id: 'failed-tiktok-task',
      url: testUrl('7421234567890123497'),
      status: 'failed',
      error: '下载失败',
      technicalError: 'HTTPS_PROXY=http://user:person8cab6@example.com',
      createdAt: Date.now()
    }]
  });

  assert.doesNotMatch(manager.getState().tasks[0].technicalError, /user|secret|proxy\.example/);
});

test('deduplicates a link already queued or completed', () => {
  const spawner = createControlledSpawner();
  const manager = new DownloadManager({
    enginePath: 'yt-dlp.exe',
    getDownloadDirectory: () => '',
    spawnProcess: spawner.spawnProcess,
    accessDirectory: async () => {},
    fileIsValid: () => true
  });
  const url = testUrl('7421234567890123481');
  assert.equal(manager.addText(url).accepted, 1);
  const second = manager.addText(`${url}?share_token=abc`);
  assert.equal(second.accepted, 0);
  assert.equal(second.duplicate, 1);
  assert.equal(manager.getState().tasks.length, 1);
});
