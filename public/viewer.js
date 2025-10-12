const viewerTitle = document.getElementById('viewerTitle');
const viewerContent = document.getElementById('viewerContent');
const tocList = document.getElementById('tocList');
const themeToggle = document.getElementById('themeToggle');
const backBtn = document.getElementById('backBtn');

// 主题持久化
const rootEl = document.documentElement;
const savedTheme = localStorage.getItem('theme') || 'dark';
rootEl.setAttribute('data-theme', savedTheme);
themeToggle.onclick = () => {
  const current = rootEl.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  rootEl.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
};

backBtn.onclick = () => {
  window.location.href = '/';
};

function getQuery() {
  const p = new URLSearchParams(window.location.search);
  return { file: p.get('file') || '', title: p.get('title') || '' };
}

async function loadMarkdown() {
  const { file, title } = getQuery();
  if (!file) {
    viewerTitle.textContent = '缺少文件参数';
    viewerContent.textContent = '';
    return;
  }
  try {
    viewerTitle.textContent = title || file;
    // 统一从 papers/ 加载文章
    const fetchPath = `/papers/${encodeURIComponent(file.replace(/^papers\//, ''))}`;
    const resp = await fetch(fetchPath);
    if (!resp.ok) throw new Error('获取文件失败');
    const md = await resp.text();
    // 使用已配置的 marked 解析
    viewerContent.innerHTML = window.marked ? window.marked.parse(md) : md;
    // 修复 SUMMARY 中的链接为绝对 /papers/ 路径，避免 base 导致重复
    Array.from(viewerContent.querySelectorAll('a[href^="papers/"]')).forEach(a => {
      const href = a.getAttribute('href');
      a.setAttribute('href', `/${href}`);
    });
    // 构建目录
    buildToc();
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

function buildToc() {
  if (!tocList) return;
  tocList.innerHTML = '';
  const headings = viewerContent.querySelectorAll('h1, h2, h3');
  headings.forEach(h => {
    let id = h.id;
    if (!id) {
      id = slugify(h.textContent);
      if (!id) return; // 跳过空标题
      h.id = id;
    }
    const li = document.createElement('li');
    li.className = `toc-item level-${h.tagName.toLowerCase()}`;
    const a = document.createElement('a');
    a.href = `#${id}`;
    a.textContent = h.textContent || id;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `#${id}`);
    });
    li.appendChild(a);
    tocList.appendChild(li);
  });
}

loadMarkdown();
// 启用 GFM 表格解析等选项
if (window.marked && typeof window.marked.setOptions === 'function') {
  window.marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: true,
    mangle: false,
    smartLists: true
  });
}