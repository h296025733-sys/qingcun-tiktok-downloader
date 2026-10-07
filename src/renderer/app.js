'use strict';

const elements = {
  addButton: document.getElementById('addButton'),
  chooseDirectoryButton: document.getElementById('chooseDirectoryButton'),
  clearButton: document.getElementById('clearButton'),
  closeSettingsButton: document.getElementById('closeSettingsButton'),
  directoryNotice: document.getElementById('directoryNotice'),
  directoryNoticeText: document.getElementById('directoryNoticeText'),
  directoryNoticeTitle: document.getElementById('directoryNoticeTitle'),
  dropZone: document.getElementById('dropZone'),
  emptyState: document.getElementById('emptyState'),
  engineNotice: document.getElementById('engineNotice'),
  inputHint: document.getElementById('inputHint'),
  noticeChooseButton: document.getElementById('noticeChooseButton'),
  openDirectoryButton: document.getElementById('openDirectoryButton'),
  queueStats: document.getElementById('queueStats'),
  settingsBackdrop: document.getElementById('settingsBackdrop'),
  settingsButton: document.getElementById('settingsButton'),
  settingsLayer: document.getElementById('settingsLayer'),
  settingsPath: document.getElementById('settingsPath'),
  taskList: document.getElementById('taskList'),
  taskTemplate: document.getElementById('taskTemplate'),
  toastRegion: document.getElementById('toastRegion'),
  urlInput: document.getElementById('urlInput')
};

const taskElements = new Map();
const previousStatuses = new Map();
let currentState = null;
let firstStateRendered = false;
let adding = false;
let renderFrame = null;

const STATUS_LABELS = {
  queued: '等待下载',
  starting: '正在解析',
  downloading: '下载中',
  completed: '已完成',
  failed: '下载失败',
  canceled: '已取消',
  duplicate: '已跳过'
};

function scheduleRender(state) {
  currentState = state;
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render(currentState);
  });
}

function render(state) {
  if (!state) return;
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const downloadDirectory = state.downloadDirectory || '';

  elements.engineNotice.classList.toggle('is-hidden', state.engineAvailable !== false);
  renderDirectoryNotice(state, downloadDirectory);
  elements.settingsPath.textContent = downloadDirectory || '尚未设置';
  elements.openDirectoryButton.disabled = !downloadDirectory;

  renderStats(tasks);
  renderTasks(tasks);
  renderCompletionToasts(tasks);
  firstStateRendered = true;
}

function renderDirectoryNotice(state, downloadDirectory) {
  const needsDirectory = !downloadDirectory || Boolean(state.directoryError);
  elements.directoryNotice.classList.toggle('is-hidden', !needsDirectory);
  if (state.directoryError) {
    elements.directoryNoticeTitle.textContent = '保存位置不可用';
    elements.directoryNoticeText.textContent = '任务已暂停，请重新选择文件夹，之后会自动继续。';
  } else {
    elements.directoryNoticeTitle.textContent = '先设置保存位置';
    elements.directoryNoticeText.textContent = '只需设置一次，之后视频会自动保存，不再询问。';
  }
}

function renderStats(tasks) {
  const active = tasks.filter((task) => task.status === 'starting' || task.status === 'downloading').length;
  const queued = tasks.filter((task) => task.status === 'queued').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const terminal = tasks.filter((task) => ['completed', 'canceled', 'duplicate'].includes(task.status)).length;

  elements.queueStats.textContent = tasks.length
    ? `进行中 ${active} · 等待 ${queued} · 已完成 ${completed}`
    : '暂无任务';
  elements.clearButton.classList.toggle('is-hidden', terminal === 0);
}

function renderTasks(tasks) {
  const liveIds = new Set(tasks.map((task) => task.id));
  for (const [taskId, row] of taskElements) {
    if (liveIds.has(taskId)) continue;
    row.remove();
    taskElements.delete(taskId);
    previousStatuses.delete(taskId);
  }

  elements.emptyState.classList.toggle('is-hidden', tasks.length > 0);
  for (const task of tasks) {
    let row = taskElements.get(task.id);
    if (!row) {
      row = elements.taskTemplate.content.firstElementChild.cloneNode(true);
      row.dataset.taskId = task.id;
      taskElements.set(task.id, row);
    }
    updateTaskRow(row, task);
    elements.taskList.appendChild(row);
  }
}

function updateTaskRow(row, task) {
  row.className = `task-row status-${task.status}`;
  const title = row.querySelector('.task-title');
  title.textContent = task.title || '未命名视频';
  title.title = task.title || '';
  row.querySelector('.task-status').textContent = STATUS_LABELS[task.status] || task.status;

  const progress = Number(task.progress);
  const hasProgress = Number.isFinite(progress);
  const activeUnknownProgress = (task.status === 'starting' || task.status === 'downloading') && !hasProgress;
  row.classList.toggle('is-indeterminate', activeUnknownProgress);
  const progressFill = row.querySelector('.progress-fill');
  if (!activeUnknownProgress) {
    progressFill.style.transform = `scaleX(${Math.max(0, Math.min(100, hasProgress ? progress : 0)) / 100})`;
  } else {
    progressFill.style.removeProperty('transform');
  }

  const meta = row.querySelector('.task-meta');
  meta.textContent = taskMetaText(task);
  meta.title = task.status === 'failed' ? task.technicalError || task.error || '' : '';

  const action = row.querySelector('.task-action');
  const actionInfo = taskAction(task.status);
  action.classList.toggle('is-hidden', !actionInfo);
  if (actionInfo) {
    action.textContent = actionInfo.label;
    action.dataset.action = actionInfo.action;
    action.setAttribute('aria-label', `${actionInfo.label}：${task.title || '此任务'}`);
  } else {
    action.textContent = '';
    delete action.dataset.action;
  }
}

function taskMetaText(task) {
  if (task.status === 'failed' || task.status === 'duplicate') return task.error || '任务未完成';
  if (task.status === 'canceled') return '任务已取消，可重新加入';
  if (task.status === 'queued') return '排队中';
  if (task.status === 'starting') return '正在获取视频信息…';
  if (task.status === 'completed') {
    const fileName = String(task.outputPath || '').split(/[\\/]/).pop();
    return fileName || '视频已保存';
  }

  const pieces = [];
  if (Number.isFinite(Number(task.progress))) pieces.push(`${Math.floor(Number(task.progress))}%`);
  if (task.downloadedBytes) {
    pieces.push(task.totalBytes
      ? `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}`
      : `已下载 ${formatBytes(task.downloadedBytes)}`);
  }
  if (task.speed) pieces.push(`${formatBytes(task.speed)}/s`);
  if (Number.isFinite(Number(task.eta))) pieces.push(`剩余 ${formatDuration(task.eta)}`);
  return pieces.join(' · ') || '正在下载…';
}

function taskAction(status) {
  if (status === 'completed') return { label: '打开', action: 'show' };
  if (status === 'failed' || status === 'canceled' || status === 'duplicate') return { label: '重试', action: 'retry' };
  if (status === 'queued') return { label: '取消', action: 'cancel' };
  if (status === 'starting' || status === 'downloading') return { label: '取消', action: 'cancel' };
  return null;
}

function renderCompletionToasts(tasks) {
  for (const task of tasks) {
    const previous = previousStatuses.get(task.id);
    if (firstStateRendered && previous && previous !== 'completed' && task.status === 'completed') {
      showToast(`${task.title || '视频'} 下载成功`, 'success');
    }
    previousStatuses.set(task.id, task.status);
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast${type ? ` toast-${type}` : ''}`;
  toast.textContent = message;
  elements.toastRegion.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function openSettings() {
  document.body.classList.add('settings-open');
  elements.settingsLayer.classList.remove('is-hidden');
  elements.settingsLayer.setAttribute('aria-hidden', 'false');
  elements.closeSettingsButton.focus();
}

function closeSettings() {
  document.body.classList.remove('settings-open');
  elements.settingsLayer.classList.add('is-hidden');
  elements.settingsLayer.setAttribute('aria-hidden', 'true');
  elements.settingsButton.focus();
}

async function chooseDirectory() {
  elements.chooseDirectoryButton.disabled = true;
  elements.noticeChooseButton.disabled = true;
  try {
    await window.qingcun.chooseDirectory();
  } finally {
    elements.chooseDirectoryButton.disabled = false;
    elements.noticeChooseButton.disabled = false;
  }
}

async function addLinks() {
  const input = elements.urlInput.value.trim();
  if (!input || adding) return;
  adding = true;
  elements.addButton.disabled = true;
  elements.inputHint.className = 'input-hint';
  elements.inputHint.textContent = '正在识别链接…';

  try {
    const result = await window.qingcun.addLinks(input);
    const details = [];
    if (result.duplicate) details.push(`重复 ${result.duplicate}`);
    if (result.invalid) details.push(`无效 ${result.invalid}`);

    if (result.accepted > 0) {
      elements.urlInput.value = '';
      elements.inputHint.className = 'input-hint is-success';
      elements.inputHint.textContent = `已加入 ${result.accepted} 条${details.length ? `：${details.join(' · ')}` : ''}`;
      elements.urlInput.dispatchEvent(new Event('input'));
    } else {
      elements.inputHint.className = 'input-hint is-error';
      elements.inputHint.textContent = result.duplicate
        ? '这些视频已在任务列表中'
        : '没有识别到 TikTok 单条视频链接';
    }
  } catch (_error) {
    elements.inputHint.className = 'input-hint is-error';
    elements.inputHint.textContent = '加入失败，请再试一次';
  } finally {
    adding = false;
    elements.addButton.disabled = !elements.urlInput.value.trim();
  }
}

elements.urlInput.addEventListener('input', () => {
  elements.addButton.disabled = adding || !elements.urlInput.value.trim();
  if (!elements.urlInput.value.trim()) {
    elements.inputHint.className = 'input-hint';
    elements.inputHint.textContent = '仅处理你提交的链接，重复项会自动跳过';
  }
});

elements.urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    addLinks();
  }
});

elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropZone.classList.add('is-dragging');
});
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('is-dragging'));
elements.dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove('is-dragging');
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  if (!text) return;
  elements.urlInput.value = [elements.urlInput.value.trim(), text.trim()].filter(Boolean).join('\n');
  elements.urlInput.dispatchEvent(new Event('input'));
  elements.urlInput.focus();
});

elements.addButton.addEventListener('click', addLinks);
elements.settingsButton.addEventListener('click', openSettings);
elements.closeSettingsButton.addEventListener('click', closeSettings);
elements.settingsBackdrop.addEventListener('click', closeSettings);
elements.noticeChooseButton.addEventListener('click', chooseDirectory);
elements.chooseDirectoryButton.addEventListener('click', chooseDirectory);
elements.openDirectoryButton.addEventListener('click', () => window.qingcun.openDirectory());
elements.clearButton.addEventListener('click', () => window.qingcun.clearCompleted());
elements.taskList.addEventListener('click', (event) => {
  const button = event.target.closest('.task-action');
  const row = button && button.closest('.task-row');
  if (!button || !row || !button.dataset.action) return;
  const taskId = row.dataset.taskId;
  if (button.dataset.action === 'show') window.qingcun.showFile(taskId);
  if (button.dataset.action === 'retry') window.qingcun.retryTask(taskId);
  if (button.dataset.action === 'cancel') window.qingcun.cancelTask(taskId);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.settingsLayer.classList.contains('is-hidden')) closeSettings();
});

window.qingcun.onStateChanged(scheduleRender);
window.qingcun.getState().then(scheduleRender).catch(() => {
  elements.engineNotice.classList.remove('is-hidden');
});
