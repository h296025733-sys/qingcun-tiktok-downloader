'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractSupportedLinks, normalizeSupportedUrl } = require('./link-parser');

const ACTIVE_STATUSES = new Set(['queued', 'starting', 'downloading']);
const DEDUPE_STATUSES = new Set(['queued', 'starting', 'downloading', 'completed', 'failed']);
const RESTORABLE_STATUSES = new Set([
  'queued',
  'starting',
  'downloading',
  'completed',
  'failed',
  'canceled',
  'duplicate'
]);

function buildYtDlpArgs({ downloadDirectory, url, proxyUrl }) {
  const args = [
    '--ignore-config',
    '--no-update',
    '--no-playlist',
    '--no-simulate',
    '--newline',
    '--progress',
    '--progress-delta', '0.25',
    '--encoding', 'utf-8',
    '--output-na-placeholder', 'null',
    '--check-formats',
    '--retries', '5',
    '--fragment-retries', '5',
    '--file-access-retries', '3',
    '--extractor-retries', '3',
    '--retry-sleep', 'http:exp=1:20',
    '--retry-sleep', 'fragment:exp=1:20',
    '--retry-sleep', 'extractor:exp=1:8',
    '--socket-timeout', '30',
    '--windows-filenames',
    '--trim-filenames', '180',
    '--continue',
    '--part',
    '--no-overwrites',
    '--paths', downloadDirectory,
    '--output', '%(title).150B [%(id)s].%(ext)s',
    '--format', 'b[ext=mp4][format_id!^=download][format_note!*=?watermarked][vcodec!*=bytevc2]',
    '--format-sort', 'vcodec:h264,acodec:aac,res,fps,br',
    '--print', 'before_dl:__QC_ID__%(id)j',
    '--print', 'before_dl:__QC_TITLE__%(title)j',
    '--print', 'before_dl:__QC_EXTRACTOR__%(extractor_key)j',
    '--print', 'after_move:__QC_FILE__%(filepath)j',
    '--progress-template', 'download:__QC_PROGRESS__%(progress.downloaded_bytes)j|%(progress.total_bytes)j|%(progress.total_bytes_estimate)j|%(progress.speed)j|%(progress.eta)j|%(progress.status)j',
  ];

  if (typeof proxyUrl === 'string') args.push('--proxy', proxyUrl);
  args.push('--', url);
  return args;
}

function stripControlCodes(value) {
  return String(value || '')
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function friendlyDownloadError(stderr) {
  const raw = stripControlCodes(stderr);
  const lower = raw.toLowerCase();

  if (/no space left|disk full|磁盘空间/.test(lower)) return '磁盘空间不足，清理空间后再重试';
  if (/requested format is not available|no video formats|no formats found|does not pass filter/.test(lower)) {
    return '没有找到可用的无水印 MP4 视频（图文或直播不支持）';
  }
  if (/unsupported url|not a valid url|no suitable extractor/.test(lower)) return '该链接不是可下载的单条视频';
  if (/proxy authentication required|proxy[^\n]{0,80}login required|http (?:error )?407|status(?: code)? 407/.test(lower)) {
    return 'Windows 系统代理需要身份验证，请先在浏览器或代理软件中完成认证';
  }
  if (/socks[^\n]{0,80}auth(?:entication)? (?:failed|required)|proxy[^\n]{0,80}auth(?:entication)? (?:failed|required)/.test(lower)) {
    return 'Windows 系统代理需要身份验证，请先在浏览器或代理软件中完成认证';
  }
  if (/proxyerror|unable to connect to (?:the )?proxy|cannot connect to (?:the )?proxy|could not connect to (?:the )?proxy|failed to connect[^\n]*over proxy|err_proxy_connection_failed|proxy connection (?:failed|refused)|tunnel connection failed|proxy tunnel/.test(lower)) {
    return 'Windows 系统代理无法连接，请确认代理软件正在运行或关闭失效的系统代理';
  }
  if (/getaddrinfo failed|could not resolve host|failed to resolve|name or service not known|winerror 11001|temporary failure in name resolution/.test(lower)) {
    return '无法解析 TikTok 地址，请检查 DNS、网络或系统代理';
  }
  if (/certificate verify failed|ssl certificate|tls handshake|ssl_error|certificate (?:has )?expired/.test(lower)) {
    return '安全连接失败，请检查系统时间、证书或安全软件';
  }
  if (/timed? out|winerror 10060|operation timeout/.test(lower)) {
    return '连接 TikTok 超时，请检查网络或系统代理';
  }
  if (/login|sign in|cookie|captcha|challenge|verify (?:that )?you are|fresh cookies/.test(lower)) {
    return '平台要求登录或验证，当前无法下载这条视频';
  }
  if (/private|unavailable|removed|deleted|not available in your country|geo.?restrict|region/.test(lower)) {
    return '视频不可用，可能已删除、私密或受地区限制';
  }
  if (/http error 429|too many requests/.test(lower)) return '请求过于频繁，请稍后重试';
  if (/http error 403|forbidden|access denied/.test(lower)) return '平台暂时拒绝访问，请稍后重试';
  if (/network is unreachable|connection (?:reset|refused|aborted)|unable to download|could not connect to server/.test(lower)) {
    return '当前网络无法访问 TikTok，请先确认浏览器能正常打开 TikTok';
  }
  if (/unable to extract|could not find|unexpected response/.test(lower)) return '平台页面发生变化，暂时无法解析这条视频';
  return '下载失败，请稍后重试';
}

function isRetryableProxyFailure(stderr) {
  const lower = stripControlCodes(stderr).toLowerCase();
  if (!lower) return false;
  if (/\b407\b|proxy[^\n]{0,80}login required|http (?:error )?403|status(?: code)? 403|socks[^\n]{0,80}auth(?:entication)? (?:failed|required)|proxy[^\n]{0,80}auth(?:entication)? (?:failed|required)/.test(lower)) {
    return false;
  }
  return /proxyerror|unable to connect to (?:the )?proxy|cannot connect to (?:the )?proxy|could not connect to (?:the )?proxy|failed to connect[^\n]*over proxy|err_proxy_connection_failed|proxy connection (?:failed|refused)|tunnel connection failed|proxy tunnel failed/.test(lower)
    || /(?:proxy[^\n]{0,120}winerror 10061|winerror 10061[^\n]{0,120}proxy)/.test(lower)
    || /curl:\s*\((?:5|7)\)[^\n]{0,240}proxy/.test(lower);
}

function sanitizeTechnicalError(stderr) {
  return clampText(stripControlCodes(stderr)
    .replace(/\b(?:https?|socks4|socks5h?):\/\/[^\s'\"<>]+/gi, '[网络地址]')
    .replace(/\b((?:over|via|through|to)\s+proxy(?: server)?(?: at)?\s+)(?!(?:authentication|required|connection|connect|error|tunnel|failed)\b)(?:\[[^\]]+\]|[a-z0-9._-]+)(?::\d+)?\b/gi, '$1[系统代理]'), 1200);
}

function normalizeProxyCandidates(candidates) {
  if (Array.isArray(candidates) && candidates.length === 0) return [];
  const normalized = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate !== null && typeof candidate !== 'string') continue;
    if (!normalized.includes(candidate)) normalized.push(candidate);
    if (normalized.length >= 5) break;
  }
  return normalized.length ? normalized : [null];
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function parseEngineLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return null;

  const singleValuePrefixes = [
    ['__QC_ID__', 'id'],
    ['__QC_TITLE__', 'title'],
    ['__QC_EXTRACTOR__', 'extractor'],
    ['__QC_FILE__', 'file']
  ];

  for (const [prefix, type] of singleValuePrefixes) {
    if (line.startsWith(prefix)) {
      return { type, value: parseJsonValue(line.slice(prefix.length)) };
    }
  }

  if (line.startsWith('__QC_PROGRESS__')) {
    const values = line.slice('__QC_PROGRESS__'.length).split('|').map(parseJsonValue);
    return {
      type: 'progress',
      downloadedBytes: toFiniteNumber(values[0]),
      totalBytes: toFiniteNumber(values[1]) || toFiniteNumber(values[2]),
      speed: toFiniteNumber(values[3]),
      eta: toFiniteNumber(values[4]),
      status: typeof values[5] === 'string' ? values[5] : ''
    };
  }

  return null;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isPathInside(baseDirectory, candidatePath) {
  if (!baseDirectory || !candidatePath) return false;
  const base = path.resolve(baseDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createLineCollector(stream, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (pending) onLine(pending);
  });
}

function clampText(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

class DownloadManager extends EventEmitter {
  constructor(options) {
    super();
    this.enginePath = options.enginePath;
    this.getDownloadDirectory = options.getDownloadDirectory;
    this.concurrency = Math.max(1, Math.min(5, options.concurrency || 3));
    this.spawnProcess = options.spawnProcess || spawn;
    this.getProxyCandidates = options.getProxyCandidates || (async () => [null]);
    this.fileIsValid = options.fileIsValid || defaultFileIsValid;
    this.accessDirectory = options.accessDirectory || defaultAccessDirectory;
    this.tasks = [];
    this.active = new Map();
    this.pumping = false;
    this.shuttingDown = false;
    this.directoryError = '';
    this.restore(options.initialTasks || []);
  }

  restore(initialTasks) {
    for (const rawTask of initialTasks.slice(-200)) {
      const normalizedLink = normalizeSupportedUrl(rawTask && rawTask.url);
      if (!normalizedLink || !rawTask.id || !RESTORABLE_STATUSES.has(rawTask.status)) continue;

      let status = rawTask.status;
      if (status === 'starting' || status === 'downloading') status = 'queued';
      if (status === 'completed' && (!rawTask.outputPath || !this.fileIsValid(rawTask.outputPath))) continue;

      this.tasks.push({
        id: String(rawTask.id),
        url: normalizedLink.url,
        normalizedUrl: normalizedLink.normalized,
        key: normalizedLink.key,
        resolvedKey: clampText(rawTask.resolvedKey, 200),
        platform: normalizedLink.platform,
        title: clampText(rawTask.title, 180) || '等待下载',
        status,
        progress: status === 'completed' ? 100 : 0,
        downloadedBytes: status === 'completed' ? toFiniteNumber(rawTask.downloadedBytes) : null,
        totalBytes: status === 'completed' ? toFiniteNumber(rawTask.totalBytes) : null,
        speed: null,
        eta: null,
        outputPath: status === 'completed' ? String(rawTask.outputPath) : '',
        error: status === 'failed' ? clampText(rawTask.error, 240) : '',
        technicalError: status === 'failed' ? sanitizeTechnicalError(rawTask.technicalError) : '',
        createdAt: Number(rawTask.createdAt) || Date.now(),
        startedAt: null,
        completedAt: status === 'completed' ? Number(rawTask.completedAt) || Date.now() : null,
        downloadDirectory: ''
      });
    }
  }

  getState() {
    const tasks = this.tasks.map((task) => ({ ...task }));
    const counts = tasks.reduce((accumulator, task) => {
      accumulator[task.status] = (accumulator[task.status] || 0) + 1;
      return accumulator;
    }, {});
    return {
      tasks,
      counts,
      activeCount: this.active.size,
      directoryError: this.directoryError
    };
  }

  getPersistableTasks() {
    return this.tasks.map((task) => ({ ...task, speed: null, eta: null }));
  }

  addText(text) {
    const parsed = extractSupportedLinks(text);
    const existingKeys = new Set(
      this.tasks.filter((task) => DEDUPE_STATUSES.has(task.status)).flatMap((task) => [task.key, task.resolvedKey].filter(Boolean))
    );
    let duplicateExisting = 0;
    const platforms = { tiktok: 0 };

    for (const link of parsed.links) {
      if (existingKeys.has(link.key)) {
        duplicateExisting += 1;
        continue;
      }
      existingKeys.add(link.key);
      platforms[link.platform] += 1;
      this.tasks.push(this.#createTask(link));
    }

    const accepted = platforms.tiktok;
    this.#emitChange('tasks-added');
    this.pump();

    return {
      accepted,
      platforms,
      duplicate: parsed.duplicateInInput + duplicateExisting,
      invalid: parsed.invalidCount,
      found: parsed.foundCount
    };
  }

  #createTask(link) {
    return {
      id: crypto.randomUUID(),
      url: link.url,
      normalizedUrl: link.normalized,
      key: link.key,
      resolvedKey: link.videoId ? `${link.platform}:${link.videoId}` : '',
      platform: link.platform,
      title: '等待下载',
      status: 'queued',
      progress: 0,
      downloadedBytes: null,
      totalBytes: null,
      speed: null,
      eta: null,
      outputPath: '',
      error: '',
      technicalError: '',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      downloadDirectory: ''
    };
  }

  async pump() {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;

    try {
      const downloadDirectory = this.getDownloadDirectory();
      if (!downloadDirectory) return;

      try {
        await this.accessDirectory(downloadDirectory);
        if (this.directoryError) {
          this.directoryError = '';
          this.#emitChange('directory-valid');
        }
      } catch (_error) {
        const nextError = '保存位置不可用，请在设置中重新选择';
        if (this.directoryError !== nextError) {
          this.directoryError = nextError;
          this.#emitChange('directory-invalid');
        }
        return;
      }

      while (this.active.size < this.concurrency) {
        const task = this.tasks.find((candidate) => candidate.status === 'queued');
        if (!task) break;
        this.#startTask(task, downloadDirectory);
      }
    } finally {
      this.pumping = false;
    }
  }

  notifyDirectoryChanged() {
    this.directoryError = '';
    this.#emitChange('directory-changed');
    this.pump();
  }

  retryTask(taskId) {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !['failed', 'canceled', 'duplicate'].includes(task.status)) return false;
    task.status = 'queued';
    task.title = task.title || '等待下载';
    task.progress = 0;
    task.downloadedBytes = null;
    task.totalBytes = null;
    task.speed = null;
    task.eta = null;
    task.outputPath = '';
    task.error = '';
    task.technicalError = '';
    task.startedAt = null;
    task.completedAt = null;
    task.downloadDirectory = '';
    this.#emitChange('task-retried');
    this.pump();
    return true;
  }

  cancelTask(taskId) {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;

    if (task.status === 'queued') {
      task.status = 'canceled';
      task.error = '';
      this.#emitChange('task-canceled');
      return true;
    }

    const activeEntry = this.active.get(taskId);
    if (!activeEntry) return false;
    activeEntry.cancelReason = 'user';
    if (activeEntry.child) activeEntry.child.kill();
    else this.#finalizeTask(task, activeEntry, null);
    return true;
  }

  removeTask(taskId) {
    const index = this.tasks.findIndex((candidate) => candidate.id === taskId);
    if (index < 0 || ACTIVE_STATUSES.has(this.tasks[index].status)) return false;
    this.tasks.splice(index, 1);
    this.#emitChange('task-removed');
    return true;
  }

  clearCompleted() {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => !['completed', 'canceled', 'duplicate'].includes(task.status));
    if (this.tasks.length !== before) this.#emitChange('completed-cleared');
    return before - this.tasks.length;
  }

  shutdown() {
    this.shuttingDown = true;
    for (const [taskId, entry] of Array.from(this.active)) {
      entry.cancelReason = 'shutdown';
      const task = this.tasks.find((candidate) => candidate.id === taskId);
      if (task) {
        task.status = 'queued';
        task.progress = 0;
        task.speed = null;
        task.eta = null;
      }
      if (entry.child) entry.child.kill();
      else {
        entry.finalized = true;
        this.active.delete(taskId);
      }
    }
    this.#emitChange('shutdown');
  }

  #startTask(task, downloadDirectory) {
    task.status = 'starting';
    task.title = task.title === '等待下载' ? '正在获取视频信息…' : task.title;
    task.startedAt = Date.now();
    task.downloadDirectory = downloadDirectory;
    task.error = '';
    task.technicalError = '';

    const entry = {
      child: null,
      cancelReason: '',
      stderrLines: [],
      attemptErrors: [],
      proxyCandidates: [null],
      proxyIndex: 0,
      finalized: false
    };
    this.active.set(task.id, entry);
    this.#emitChange('task-started');
    this.#resolveProxyAndSpawnTask(task, entry, downloadDirectory);
  }

  async #resolveProxyAndSpawnTask(task, entry, downloadDirectory) {
    let candidates;
    try {
      candidates = normalizeProxyCandidates(await this.getProxyCandidates(task.url));
    } catch (_error) {
      candidates = [null];
    }

    if (entry.finalized || entry.cancelReason || this.shuttingDown || this.active.get(task.id) !== entry) return;
    if (!candidates.length) {
      entry.finalized = true;
      this.active.delete(task.id);
      task.status = 'failed';
      task.error = '无法读取 Windows 网络代理设置，请重启软件后重试';
      task.technicalError = 'QC_PROXY_RESOLUTION_FAILED';
      this.#emitChange('proxy-resolution-failed');
      this.pump();
      return;
    }
    entry.proxyCandidates = candidates;
    entry.proxyIndex = 0;
    this.#spawnTask(task, entry, downloadDirectory);
  }

  #spawnTask(task, entry, downloadDirectory) {
    if (entry.finalized || entry.cancelReason || this.shuttingDown || this.active.get(task.id) !== entry) return;
    const proxyUrl = entry.proxyCandidates[entry.proxyIndex];
    const args = buildYtDlpArgs({
      downloadDirectory,
      url: task.url,
      proxyUrl
    });
    let child;
    try {
      child = this.spawnProcess(this.enginePath, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      entry.finalized = true;
      this.active.delete(task.id);
      task.status = 'failed';
      task.error = '下载引擎无法启动，请重新安装程序';
      task.technicalError = clampText(error && error.message, 1200);
      this.#emitChange('engine-start-failed');
      queueMicrotask(() => this.pump());
      return;
    }

    entry.child = child;
    entry.stderrLines = [];

    createLineCollector(child.stdout, (line) => {
      if (!entry.finalized && entry.child === child) this.#handleStdout(task, entry, line);
    });
    createLineCollector(child.stderr, (line) => {
      if (entry.finalized || entry.child !== child) return;
      const cleaned = stripControlCodes(line);
      if (!cleaned) return;
      entry.stderrLines.push(cleaned);
      if (entry.stderrLines.length > 30) entry.stderrLines.shift();
    });

    child.once('error', (error) => {
      if (!entry.finalized && entry.child === child) entry.stderrLines.push(error.message || String(error));
    });
    child.once('close', (code) => {
      if (entry.finalized || entry.child !== child) return;
      entry.child = null;
      this.#handleProcessClose(task, entry, downloadDirectory, code);
    });
    this.#emitChange('engine-started');
  }

  #handleProcessClose(task, entry, downloadDirectory, code) {
    const currentError = entry.stderrLines.join(' ');
    const hasNextProxyRoute = entry.proxyIndex + 1 < entry.proxyCandidates.length;
    const currentProxyRoute = entry.proxyCandidates[entry.proxyIndex];
    if (!entry.cancelReason && !this.shuttingDown && code !== 0 && hasNextProxyRoute
      && typeof currentProxyRoute === 'string' && currentProxyRoute !== '' && isRetryableProxyFailure(currentError)) {
      entry.attemptErrors.push(currentError);
      entry.proxyIndex += 1;
      task.status = 'starting';
      task.progress = 0;
      task.downloadedBytes = null;
      task.totalBytes = null;
      task.speed = null;
      task.eta = null;
      this.#emitChange('proxy-route-retry');
      this.#spawnTask(task, entry, downloadDirectory);
      return;
    }

    this.#finalizeTask(task, entry, code, currentError);
  }

  #handleStdout(task, entry, line) {
    const message = parseEngineLine(line);
    if (!message) return;

    if (message.type === 'title') {
      task.title = clampText(message.value, 180) || '未命名视频';
    } else if (message.type === 'id') {
      const videoId = clampText(message.value, 100);
      if (videoId) {
        task.resolvedKey = `${task.platform}:${videoId}`;
        if (this.#hasOlderDuplicate(task)) {
          entry.cancelReason = 'duplicate';
          if (entry.child) entry.child.kill();
        }
      }
    } else if (message.type === 'file') {
      const candidate = typeof message.value === 'string' ? message.value : '';
      if (isPathInside(task.downloadDirectory, candidate)) task.outputPath = path.resolve(candidate);
    } else if (message.type === 'progress') {
      task.status = 'downloading';
      task.downloadedBytes = message.downloadedBytes;
      task.totalBytes = message.totalBytes;
      task.speed = message.speed;
      task.eta = message.eta;
      task.progress = message.totalBytes
        ? Math.max(0, Math.min(99.9, (message.downloadedBytes || 0) / message.totalBytes * 100))
        : null;
    }

    this.#emitChange('task-progress');
  }

  #hasOlderDuplicate(task) {
    return this.tasks.some((candidate) => (
      candidate.id !== task.id &&
      candidate.createdAt <= task.createdAt &&
      DEDUPE_STATUSES.has(candidate.status) &&
      (candidate.resolvedKey === task.resolvedKey || candidate.key === task.resolvedKey)
    ));
  }

  #finalizeTask(task, entry, code, currentError = '') {
    if (entry.finalized) return;
    entry.finalized = true;
    this.active.delete(task.id);

    if (entry.cancelReason === 'shutdown') {
      task.status = 'queued';
    } else if (entry.cancelReason === 'user') {
      task.status = 'canceled';
      task.error = '';
      task.speed = null;
      task.eta = null;
    } else if (entry.cancelReason === 'duplicate') {
      task.status = 'duplicate';
      task.error = '相同视频已在任务列表中，已跳过';
      task.speed = null;
      task.eta = null;
    } else if (code === 0 && task.outputPath && this.fileIsValid(task.outputPath)) {
      task.status = 'completed';
      task.progress = 100;
      task.downloadedBytes = task.totalBytes || task.downloadedBytes;
      task.speed = null;
      task.eta = null;
      task.error = '';
      task.technicalError = '';
      task.completedAt = Date.now();
    } else {
      const rawTechnicalError = currentError || entry.stderrLines.join(' ') || entry.attemptErrors.at(-1) || '';
      const technicalError = sanitizeTechnicalError(rawTechnicalError);
      task.status = 'failed';
      task.error = code === 0 ? '下载结束，但没有找到已保存的视频文件' : friendlyDownloadError(currentError || rawTechnicalError);
      task.technicalError = technicalError;
      task.speed = null;
      task.eta = null;
    }

    this.#emitChange('task-finished');
    this.pump();
  }

  #emitChange(reason) {
    this.emit('change', this.getState(), reason);
  }
}

async function defaultAccessDirectory(directory) {
  const stats = await fs.promises.stat(directory);
  if (!stats.isDirectory()) throw new Error('Not a directory');
  await fs.promises.access(directory, fs.constants.W_OK);
}

function defaultFileIsValid(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  DownloadManager,
  buildYtDlpArgs,
  friendlyDownloadError,
  isRetryableProxyFailure,
  isPathInside,
  parseEngineLine,
  sanitizeTechnicalError,
  stripControlCodes
};
