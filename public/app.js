const socket = io();
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const siteSelect = document.getElementById('siteSelect');
const themeToggle = document.getElementById('themeToggle');
const statusBadge = document.getElementById('statusBadge');
const liveList = document.getElementById('liveList');
const filesList = document.getElementById('filesList');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');
const logsList = document.getElementById('logsList');
const progressBar = document.getElementById('progressBar');
const siteCountValue = document.getElementById('siteCountValue');
const currentSiteValue = document.getElementById('currentSiteValue');
const savedCountValue = document.getElementById('savedCountValue');
const fileCountValue = document.getElementById('fileCountValue');
// index 页面不再内嵌 Markdown 预览

// 参数表单元素
const maxPagesInput = document.getElementById('maxPages');
const concurrencyInput = document.getElementById('concurrency');
const fetchFullContentInput = document.getElementById('fetchFullContent');
const imagesOnlyInput = document.getElementById('imagesOnly');
const imageInput = document.getElementById('image');
const startDateInput = document.getElementById('startDate');
const endDateInput = document.getElementById('endDate');
const targetDateInput = document.getElementById('targetDate');
const pluginCustomFields = document.getElementById('pluginCustomFields');

const siteFormState = new Map();

function getSiteDefinition(siteId) {
  return sitesData.find((site) => site.id === siteId) || null;
}

function getSiteCustomFields(siteId) {
  const site = getSiteDefinition(siteId);
  return site && Array.isArray(site.customFields) ? site.customFields : [];
}

function getSiteDefaults(siteId) {
  const site = getSiteDefinition(siteId);
  return site && site.defaults ? site.defaults : {};
}

function coerceFieldValue(field, rawValue) {
  if (field.type === 'checkbox') return !!rawValue;
  if (field.type === 'number') {
    if (rawValue === '' || rawValue === null || rawValue === undefined) return '';
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : '';
  }
  return rawValue === null || rawValue === undefined ? '' : String(rawValue);
}

function buildDefaultSiteState(siteId) {
  const defaults = getSiteDefaults(siteId);
  const custom = {};

  getSiteCustomFields(siteId).forEach((field) => {
    if (defaults[field.key] !== undefined) {
      custom[field.key] = coerceFieldValue(field, defaults[field.key]);
    } else if (field.defaultValue !== undefined) {
      custom[field.key] = coerceFieldValue(field, field.defaultValue);
    } else {
      custom[field.key] = field.type === 'checkbox' ? false : '';
    }
  });

  return {
    maxPages: Number(defaults.maxPages || 3),
    concurrency: Number(defaults.concurrency || 3),
    fetchFullContent: defaults.fetchFullContent !== false,
    imagesOnly: !!defaults.imagesOnly,
    image: defaults.image !== false,
    startDate: defaults.startDate || '',
    endDate: defaults.endDate || '',
    targetDate: defaults.targetDate || '',
    custom,
  };
}

function getOrCreateSiteState(siteId) {
  if (!siteFormState.has(siteId)) {
    siteFormState.set(siteId, buildDefaultSiteState(siteId));
  }
  return siteFormState.get(siteId);
}

function readCustomFieldValue(field, input) {
  if (!input) return field.type === 'checkbox' ? false : '';
  if (field.type === 'checkbox') return !!input.checked;
  if (field.type === 'number') return input.value === '' ? '' : Number(input.value);
  return input.value;
}

function collectCurrentFormState() {
  const custom = {};
  const fields = getSiteCustomFields(currentSite);

  fields.forEach((field) => {
    const input = document.querySelector(`[data-custom-field-key="${field.key}"]`);
    custom[field.key] = readCustomFieldValue(field, input);
  });

  return {
    maxPages: Number(maxPagesInput.value || 3),
    concurrency: Number(concurrencyInput.value || 3),
    fetchFullContent: !!fetchFullContentInput.checked,
    imagesOnly: !!imagesOnlyInput.checked,
    image: !!imageInput.checked,
    startDate: startDateInput.value || '',
    endDate: endDateInput.value || '',
    targetDate: targetDateInput.value || '',
    custom,
  };
}

function saveCurrentSiteState() {
  if (!currentSite) return;
  siteFormState.set(currentSite, collectCurrentFormState());
}

function createCustomFieldWrapper(field) {
  const wrapper = document.createElement('div');
  const isWide = field.fullWidth || field.type === 'textarea' || !!field.description;
  wrapper.className = isWide ? 'form-item form-item-wide' : 'form-item';
  if (field.type === 'checkbox') {
    wrapper.className += ' toggle-item';
  }
  return wrapper;
}

function createCustomFieldInput(field, value) {
  let input;

  if (field.type === 'textarea') {
    input = document.createElement('textarea');
    if (field.rows) input.rows = Number(field.rows);
    input.value = value;
  } else if (field.type === 'select') {
    input = document.createElement('select');
    const options = Array.isArray(field.options) ? field.options : [];
    options.forEach((optionDef) => {
      const option = document.createElement('option');
      if (optionDef && typeof optionDef === 'object') {
        option.value = optionDef.value;
        option.textContent = optionDef.label || optionDef.value;
      } else {
        option.value = optionDef;
        option.textContent = optionDef;
      }
      input.appendChild(option);
    });
    input.value = value;
  } else {
    input = document.createElement('input');
    input.type = field.type || 'text';
    if (field.type === 'checkbox') {
      input.checked = !!value;
    } else {
      input.value = value;
    }
  }

  input.dataset.customFieldKey = field.key;
  if (field.placeholder && input.type !== 'checkbox') input.placeholder = field.placeholder;
  if (field.required) input.required = true;
  return input;
}

function renderCustomFields(siteId) {
  if (!pluginCustomFields) return;
  pluginCustomFields.innerHTML = '';

  const fields = getSiteCustomFields(siteId);
  if (!fields.length) return;

  const state = getOrCreateSiteState(siteId);

  fields.forEach((field) => {
    const wrapper = createCustomFieldWrapper(field);
    const fieldValue = state.custom && state.custom[field.key] !== undefined
      ? state.custom[field.key]
      : (field.type === 'checkbox' ? false : '');

    if (field.type === 'checkbox') {
      const toggleShell = document.createElement('div');
      toggleShell.className = 'toggle-shell';

      const copy = document.createElement('div');
      const title = document.createElement('span');
      title.className = 'switch-label';
      title.textContent = field.label || field.key;
      copy.appendChild(title);

      if (field.description) {
        const subtitle = document.createElement('span');
        subtitle.className = 'switch-subtext';
        subtitle.textContent = field.description;
        copy.appendChild(subtitle);
      }

      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch';
      const input = createCustomFieldInput(field, fieldValue);
      const slider = document.createElement('span');
      slider.className = 'slider';
      switchLabel.appendChild(input);
      switchLabel.appendChild(slider);
      toggleShell.appendChild(copy);
      toggleShell.appendChild(switchLabel);
      wrapper.appendChild(toggleShell);
    } else {
      const label = document.createElement('label');
      label.setAttribute('for', `custom-${field.key}`);
      label.textContent = field.label || field.key;
      wrapper.appendChild(label);

      const input = createCustomFieldInput(field, fieldValue);
      input.id = `custom-${field.key}`;
      wrapper.appendChild(input);
    }

    if (field.description && field.type !== 'checkbox') {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = field.description;
      wrapper.appendChild(hint);
    }

    pluginCustomFields.appendChild(wrapper);
  });
}

function applySiteState(siteId) {
  const state = getOrCreateSiteState(siteId);
  maxPagesInput.value = state.maxPages;
  concurrencyInput.value = state.concurrency;
  fetchFullContentInput.checked = !!state.fetchFullContent;
  imagesOnlyInput.checked = !!state.imagesOnly;
  imageInput.checked = !!state.image;
  startDateInput.value = state.startDate || '';
  endDateInput.value = state.endDate || '';
  targetDateInput.value = state.targetDate || '';
  renderCustomFields(siteId);
}

function getOptions() {
  saveCurrentSiteState();
  const state = getOrCreateSiteState(siteSelect.value);
  const opts = {
    site: siteSelect.value,
    maxPages: Number(state.maxPages || 3),
    concurrency: Number(state.concurrency || 3),
    fetchFullContent: !!state.fetchFullContent,
    imagesOnly: !!state.imagesOnly,
    image: !!state.image,
  };
  if (state.startDate) opts.startDate = state.startDate;
  if (state.endDate) opts.endDate = state.endDate;
  if (state.targetDate) opts.targetDate = state.targetDate;

  getSiteCustomFields(siteSelect.value).forEach((field) => {
    const value = state.custom ? state.custom[field.key] : undefined;
    if (field.type === 'checkbox') {
      opts[field.key] = !!value;
      return;
    }
    if (field.type === 'number') {
      if (value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))) {
        opts[field.key] = Number(value);
      }
      return;
    }
    const normalized = String(value || '').trim();
    if (normalized) opts[field.key] = normalized;
  });

  return opts;
}

let savedCount = 0;
let filesData = [];
let sitesData = [];
let currentSite = '';
let currentPage = 1;
const pageSize = 10;

// 主题初始化与持久化
const rootEl = document.documentElement;
const savedTheme = localStorage.getItem('theme') || 'dark';
rootEl.setAttribute('data-theme', savedTheme);

function syncThemeToggleLabel() {
  if (!themeToggle) return;
  const current = rootEl.getAttribute('data-theme') || 'dark';
  themeToggle.textContent = current === 'dark' ? '切换浅色' : '切换深色';
}

function updateOverviewStats() {
  const activeSite = getSiteDefinition(currentSite);
  if (siteCountValue) siteCountValue.textContent = String(sitesData.length || 0);
  if (currentSiteValue) currentSiteValue.textContent = activeSite ? activeSite.name : (currentSite || '未选择');
  if (savedCountValue) savedCountValue.textContent = String((liveList && liveList.childElementCount) || 0);
  if (fileCountValue) fileCountValue.textContent = String(filesData.length || 0);
}

syncThemeToggleLabel();

themeToggle.onclick = () => {
  const current = rootEl.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  rootEl.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  syncThemeToggleLabel();
};

// 预览改为跳转到独立页面
function openViewer(site, fileName, title) {
  const url = `/viewer.html?site=${encodeURIComponent(site)}&file=${encodeURIComponent(fileName)}&title=${encodeURIComponent(title || fileName)}`;
  window.location.href = url;
}

function populateSites(sites, defaultSite) {
  sitesData = sites || [];
  siteFormState.clear();
  if (!siteSelect) return;
  siteSelect.innerHTML = '';
  sitesData.forEach((site) => {
    const option = document.createElement('option');
    option.value = site.id;
    option.textContent = `${site.name} (${site.id})`;
    siteSelect.appendChild(option);
    siteFormState.set(site.id, buildDefaultSiteState(site.id));
  });
  currentSite = (defaultSite && sitesData.some((site) => site.id === defaultSite))
    ? defaultSite
    : ((sitesData[0] && sitesData[0].id) || '');
  if (currentSite) {
    siteSelect.value = currentSite;
    applySiteState(currentSite);
  }
  updateOverviewStats();
}

function createMetaText(text, className = 'item-meta') {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text || '';
  return span;
}

function createListMain(title, metaText) {
  const wrapper = document.createElement('div');
  wrapper.className = 'list-main';

  const titleEl = document.createElement('strong');
  titleEl.textContent = title;
  wrapper.appendChild(titleEl);

  if (metaText) {
    wrapper.appendChild(createMetaText(metaText));
  }

  return wrapper;
}

function setProgress(value) {
  if (progressBar) progressBar.style.width = value;
}

function logEvent(type, text) {
  if (!logsList) return;
  const li = document.createElement('li');
  const left = document.createElement('div');
  const right = document.createElement('div');
  const tag = document.createElement('span');
  tag.className = 'log-tag ' + (
    type === 'success' ? 'log-success' :
    type === 'error' ? 'log-error' :
    type === 'image' ? 'log-image' :
    type === 'file' ? 'log-file' :
    'log-info'
  );
  tag.textContent = type.toUpperCase();
  left.className = 'log-main';
  left.appendChild(tag);
  left.appendChild(createMetaText(text, 'log-text'));
  right.appendChild(createMetaText(new Date().toLocaleTimeString()));
  li.appendChild(left);
  li.appendChild(right);
  logsList.prepend(li);
}

function addLiveItem(article) {
  const li = document.createElement('li');
  const title = (article.title || '未知标题').trim();
  const left = document.createElement('div');
  const right = document.createElement('div');
  left.appendChild(createListMain(title, article.publishTime || ''));
  if (article.category) {
    right.appendChild(createMetaText(article.category, 'meta-chip'));
  }
  li.appendChild(left);
  li.appendChild(right);
  liveList.prepend(li);
  updateOverviewStats();
}

function renderFilesPage() {
  filesList.innerHTML = '';
  const totalPages = Math.max(1, Math.ceil(filesData.length / pageSize));
  currentPage = Math.max(1, Math.min(currentPage, totalPages));
  const start = (currentPage - 1) * pageSize;
  const slice = filesData.slice(start, start + pageSize);
  slice.forEach(f => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const right = document.createElement('div');
    const titleRow = document.createElement('div');
    titleRow.className = 'list-title-row';
    const summary = document.createElement('div');
    summary.className = 'list-main';
    const a = document.createElement('a');
    a.href = `/data/${encodeURIComponent(f.site)}/papers/${encodeURIComponent(f.fileName)}`;
    a.textContent = f.title;
    a.target = '_blank';
    titleRow.appendChild(a);
    const previewBtn = document.createElement('button');
    previewBtn.textContent = '预览';
    previewBtn.className = 'btn btn-sm btn-ghost';
    previewBtn.onclick = () => openViewer(f.site, f.fileName, f.title);
    titleRow.appendChild(previewBtn);
    summary.appendChild(titleRow);
    summary.appendChild(createMetaText(`站点 ${f.site} · 文件 ${f.fileName}`));
    left.appendChild(summary);

    const del = document.createElement('button');
    del.textContent = '删除';
    del.className = 'btn btn-sm btn-outline-danger';
    del.onclick = async () => {
      const resp = await fetch(`/api/articles/${encodeURIComponent(f.site)}/${encodeURIComponent(f.fileName)}`, { method: 'DELETE' });
      if (resp.ok) {
        const idx = filesData.findIndex(x => x.fileName === f.fileName);
        if (idx >= 0) filesData.splice(idx, 1);
        renderFilesPage();
      }
    };
    right.className = 'list-actions';
    right.appendChild(del);
    li.appendChild(left);
    li.appendChild(right);
    filesList.appendChild(li);
  });
  if (pageInfo) pageInfo.textContent = `第 ${currentPage} / ${Math.max(1, Math.ceil(filesData.length / pageSize))} 页`;
  if (prevPageBtn) prevPageBtn.disabled = currentPage <= 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage >= Math.ceil(filesData.length / pageSize);
  updateOverviewStats();
}

function refreshFiles(files) {
  filesData = files || [];
  currentPage = 1;
  renderFilesPage();
}

async function refreshCurrentSiteData() {
  if (!currentSite) return;
  const resp = await fetch(`/api/articles?site=${encodeURIComponent(currentSite)}`);
  const data = await resp.json();
  liveList.innerHTML = '';
  (data.articles || []).forEach(addLiveItem);
  refreshFiles(data.files || []);
}

if (prevPageBtn) {
  prevPageBtn.onclick = () => {
    currentPage = Math.max(1, currentPage - 1);
    renderFilesPage();
  };
}
if (nextPageBtn) {
  nextPageBtn.onclick = () => {
    currentPage = currentPage + 1;
    renderFilesPage();
  };
}

function setStatus(type, text) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + (
    type === 'running' ? 'badge-running' :
    type === 'complete' ? 'badge-complete' :
    type === 'error' ? 'badge-error' :
    'badge-idle'
  );
}

socket.on('init', (payload) => {
  setStatus('idle', '未运行');
  populateSites(payload.sites || [], payload.defaultSite);
  (payload.articles || []).forEach(addLiveItem);
  refreshFiles(payload.files || []);
  savedCount = (payload.articles || []).length;
  setProgress('0%');
  updateOverviewStats();
});

socket.on('run_start', (p) => {
  savedCount = 0;
  if (p.site) currentSite = p.site;
  if (siteSelect && currentSite) {
    siteSelect.value = currentSite;
    applySiteState(currentSite);
  }
  setStatus('running', `运行中：${p.plugin ? p.plugin.name : p.site} maxPages=${p.maxPages}`);
  logEvent('info', `[${p.site}] 开始运行，参数：maxPages=${p.maxPages} 并发=${p.concurrency} 完整内容=${p.fetchFullContent ? '是' : '否'}`);
  setProgress('5%');
  updateOverviewStats();
});
socket.on('article_saved', (p) => {
  if (p && p.article && p.site === currentSite) addLiveItem(p.article);
  savedCount += 1;
  logEvent('success', `[${p.site}] 已保存：${(p.article && p.article.title) || '未知标题'}`);
  const pct = Math.min(95, savedCount * 5);
  setProgress(pct + '%');
  updateOverviewStats();
});
socket.on('run_complete', (p) => {
  setStatus('complete', `完成：${p.site} 保存 ${p.totalSaved || 0}，失败 ${p.failures || 0}`);
  logEvent('info', `[${p.site}] 运行完成：保存 ${p.totalSaved || 0}，失败 ${p.failures || 0}`);
  setProgress('100%');
  updateOverviewStats();
});
socket.on('failure', (p) => {
  setStatus('error', `错误：${p && p.error ? p.error : '未知错误'}`);
  logEvent('error', `[${p && p.site ? p.site : 'unknown'}] 错误：${p && p.error ? p.error : '未知错误'}`);
});
socket.on('article_deleted', async (payload) => {
  // refresh files list after deletion
  if (payload && payload.site === currentSite) {
    await refreshCurrentSiteData();
  }
  logEvent('file', `[${payload && payload.site ? payload.site : 'unknown'}] 文件已删除`);
});

// 图片本地化事件
socket.on('image_localize_start', (p) => {
  logEvent('image', `[${p.site}] 图片本地化开始：${p.totalFiles || 0} 个文件`);
});
socket.on('image_localized', (p) => {
  logEvent('image', `[${p.site}] 更新 ${p.fileName}: ${p.replacements || 0} 处链接`);
});
socket.on('image_localize_complete', (p) => {
  logEvent('image', `[${p.site}] 图片本地化完成：扫描 ${p.scanned || 0}，下载 ${p.downloaded || 0}`);
});

startBtn.onclick = async () => {
  setStatus('running', '启动中...');
  const options = getOptions();
  logEvent('info', '提交参数并启动');
  await fetch('/api/crawl/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options)
  });
};

stopBtn.onclick = async () => {
  await fetch('/api/crawl/stop', { method: 'POST' });
  setStatus('idle', '停止中...');
  logEvent('info', '停止命令已发送');
  updateOverviewStats();
};

if (siteSelect) {
  siteSelect.onchange = async () => {
    saveCurrentSiteState();
    currentSite = siteSelect.value;
    applySiteState(currentSite);
    liveList.innerHTML = '';
    await refreshCurrentSiteData();
    setStatus('idle', `当前站点：${currentSite}`);
    updateOverviewStats();
  };
}
