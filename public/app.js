const socket = io();
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const themeToggle = document.getElementById('themeToggle');
const statusBadge = document.getElementById('statusBadge');
const liveList = document.getElementById('liveList');
const filesList = document.getElementById('filesList');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');
const logsList = document.getElementById('logsList');
const progressBar = document.getElementById('progressBar');
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

function getOptions() {
  const opts = {
    maxPages: Number(maxPagesInput.value || 3),
    concurrency: Number(concurrencyInput.value || 3),
    fetchFullContent: !!fetchFullContentInput.checked,
    imagesOnly: !!imagesOnlyInput.checked,
    image: !!imageInput.checked,
  };
  if (startDateInput.value) opts.startDate = startDateInput.value;
  if (endDateInput.value) opts.endDate = endDateInput.value;
  if (targetDateInput.value) opts.targetDate = targetDateInput.value;
  return opts;
}

let savedCount = 0;
let filesData = [];
let currentPage = 1;
const pageSize = 10;

// 主题初始化与持久化
const rootEl = document.documentElement;
const savedTheme = localStorage.getItem('theme') || 'dark';
rootEl.setAttribute('data-theme', savedTheme);

themeToggle.onclick = () => {
  const current = rootEl.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  rootEl.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
};

// 预览改为跳转到独立页面
function openViewer(fileName, title) {
  const url = `/viewer.html?file=${encodeURIComponent(fileName)}&title=${encodeURIComponent(title || fileName)}`;
  window.location.href = url;
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
    type === 'summary' ? 'log-summary' :
    'log-info'
  );
  tag.textContent = type.toUpperCase();
  left.appendChild(tag);
  const txt = document.createElement('span');
  txt.style.marginLeft = '8px';
  txt.textContent = text;
  left.appendChild(txt);
  const time = document.createElement('span');
  time.className = 'item-meta';
  time.textContent = new Date().toLocaleTimeString();
  right.appendChild(time);
  li.appendChild(left);
  li.appendChild(right);
  logsList.prepend(li);
}

function addLiveItem(article) {
  const li = document.createElement('li');
  const title = (article.title || '未知标题').trim();
  const left = document.createElement('div');
  const right = document.createElement('div');
  left.innerHTML = `<strong>${title}</strong><div class="item-meta">${article.publishTime || ''}</div>`;
  right.innerHTML = `<span class="item-meta">${article.category || ''}</span>`;
  li.appendChild(left);
  li.appendChild(right);
  liveList.prepend(li);
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
    const a = document.createElement('a');
    a.href = `/papers/${encodeURIComponent(f.fileName)}`;
    a.textContent = f.title;
    a.target = '_blank';
    left.appendChild(a);
    const previewBtn = document.createElement('button');
    previewBtn.textContent = '🔍 预览';
    previewBtn.className = 'btn btn-sm btn-ghost';
    previewBtn.style.marginLeft = '8px';
    previewBtn.onclick = () => openViewer(f.fileName, f.title);
    left.appendChild(previewBtn);
    const del = document.createElement('button');
    del.textContent = '🗑️ 删除';
    del.className = 'btn btn-sm btn-outline-danger';
    del.onclick = async () => {
      const resp = await fetch(`/api/articles/${encodeURIComponent(f.fileName)}`, { method: 'DELETE' });
      if (resp.ok) {
        const idx = filesData.findIndex(x => x.fileName === f.fileName);
        if (idx >= 0) filesData.splice(idx, 1);
        renderFilesPage();
      }
    };
    right.appendChild(del);
    li.appendChild(left);
    li.appendChild(right);
    filesList.appendChild(li);
  });
  if (pageInfo) pageInfo.textContent = `第 ${currentPage} / ${Math.max(1, Math.ceil(filesData.length / pageSize))} 页`;
  if (prevPageBtn) prevPageBtn.disabled = currentPage <= 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage >= Math.ceil(filesData.length / pageSize);
}

function refreshFiles(files) {
  filesData = files || [];
  currentPage = 1;
  renderFilesPage();
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
  (payload.articles || []).forEach(addLiveItem);
  refreshFiles(payload.files || []);
  savedCount = (payload.articles || []).length;
  if (progressBar) progressBar.style.width = '0%';
});

socket.on('run_start', (p) => {
  savedCount = 0;
  setStatus('running', `运行中：maxPages=${p.maxPages}, concurrency=${p.concurrency}`);
  logEvent('info', `开始运行，参数：maxPages=${p.maxPages} 并发=${p.concurrency} 完整内容=${p.fetchFullContent ? '是' : '否'}`);
  if (progressBar) progressBar.style.width = '5%';
});
socket.on('article_saved', (p) => {
  if (p && p.article) addLiveItem(p.article);
  savedCount += 1;
  logEvent('success', `已保存：${(p.article && p.article.title) || '未知标题'}`);
  const pct = Math.min(95, savedCount * 5);
  if (progressBar) progressBar.style.width = pct + '%';
});
socket.on('summary_updated', async () => {
  const resp = await fetch('/api/articles');
  const data = await resp.json();
  refreshFiles(data.files || []);
  logEvent('summary', '汇总已更新');
});
socket.on('run_complete', (p) => {
  setStatus('complete', `完成：已保存 ${p.totalSaved || 0}，失败 ${p.failures || 0}`);
  logEvent('info', `运行完成：保存 ${p.totalSaved || 0}，失败 ${p.failures || 0}`);
  if (progressBar) progressBar.style.width = '100%';
});
socket.on('failure', (p) => {
  setStatus('error', `错误：${p && p.error ? p.error : '未知错误'}`);
  logEvent('error', `错误：${p && p.error ? p.error : '未知错误'}`);
});
socket.on('article_deleted', () => {
  // refresh files list after deletion
  (async () => {
    const resp = await fetch('/api/articles');
    const data = await resp.json();
    refreshFiles(data.files || []);
  })();
  logEvent('file', '文件已删除');
});

// 图片本地化事件
socket.on('image_localize_start', (p) => {
  logEvent('image', `图片本地化开始：${p.totalFiles || 0} 个文件`);
});
socket.on('image_localized', (p) => {
  logEvent('image', `更新 ${p.fileName}: ${p.replacements || 0} 处链接`);
});
socket.on('image_localize_complete', (p) => {
  logEvent('image', `图片本地化完成：扫描 ${p.scanned || 0}，下载 ${p.downloaded || 0}`);
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
};