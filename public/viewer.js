const viewerTitle = document.getElementById('viewerTitle');
const viewerContent = document.getElementById('viewerContent');
const tocList = document.getElementById('tocList');
const themeToggle = document.getElementById('themeToggle');
const backBtn = document.getElementById('backBtn');

const rootEl = document.documentElement;
const savedTheme = localStorage.getItem('theme') || 'dark';
rootEl.setAttribute('data-theme', savedTheme);

function syncThemeToggleLabel() {
  if (!themeToggle) return;
  const current = rootEl.getAttribute('data-theme') || 'dark';
  themeToggle.textContent = current === 'dark' ? '切换浅色' : '切换深色';
}

syncThemeToggleLabel();

themeToggle.onclick = () => {
  const current = rootEl.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  rootEl.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  syncThemeToggleLabel();
};

backBtn.onclick = () => {
  window.location.href = '/';
};

function getQuery() {
  const p = new URLSearchParams(window.location.search);
  return { site: p.get('site') || '', file: p.get('file') || '', title: p.get('title') || '' };
}

async function loadMarkdown() {
  const { site, file, title } = getQuery();
  if (!site || !file) {
    viewerTitle.textContent = '缺少文件参数';
    viewerContent.textContent = '';
    return;
  }
  try {
    viewerTitle.textContent = `[${site}] ${title || file}`;
    const fetchPath = `/data/${encodeURIComponent(site)}/papers/${encodeURIComponent(file.replace(/^papers\//, ''))}`;
    const resp = await fetch(fetchPath);
    if (!resp.ok) throw new Error('获取文件失败');
    const md = await resp.text();
    viewerContent.innerHTML = window.marked ? window.marked.parse(md) : md;

    Array.from(viewerContent.querySelectorAll('a[href^="papers/"]')).forEach((a) => {
      const href = a.getAttribute('href');
      a.setAttribute('href', `/data/${encodeURIComponent(site)}/${href}`);
    });

    Array.from(viewerContent.querySelectorAll('img')).forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (/^(https?:|data:|\/)/i.test(src)) return;
      img.setAttribute('src', `/data/${encodeURIComponent(site)}/papers/${src.replace(/^\.\//, '')}`);
    });

    buildToc();
    restoreHashLocation();
  } catch (e) {
    viewerTitle.textContent = '加载失败';
    viewerContent.textContent = String(e);
  }
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function createUniqueHeadingId(baseId, seenIds) {
  if (!baseId) return '';
  if (!seenIds.has(baseId)) {
    seenIds.add(baseId);
    return baseId;
  }
  let index = 2;
  while (seenIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  const nextId = `${baseId}-${index}`;
  seenIds.add(nextId);
  return nextId;
}

function buildToc() {
  if (!tocList) return;
  tocList.innerHTML = '';
  const headings = viewerContent.querySelectorAll('h1, h2, h3');
  const seenIds = new Set();

  headings.forEach((heading) => {
    let id = heading.id || slugify(heading.textContent);
    id = createUniqueHeadingId(id, seenIds);
    if (!id) return;
    heading.id = id;

    const li = document.createElement('li');
    li.className = `toc-item level-${heading.tagName.toLowerCase()}`;
    const a = document.createElement('a');
    a.href = `#${id}`;
    a.textContent = heading.textContent || id;
    a.addEventListener('click', (event) => {
      event.preventDefault();
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `#${id}`);
    });
    li.appendChild(a);
    tocList.appendChild(li);
  });
}

function restoreHashLocation() {
  const hash = decodeURIComponent(window.location.hash || '').replace(/^#/, '');
  if (!hash) return;
  const target = document.getElementById(hash);
  if (target) {
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start' });
    });
  }
}

if (window.marked && typeof window.marked.setOptions === 'function') {
  window.marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: true,
    mangle: false,
    smartLists: true,
  });
}

loadMarkdown();
