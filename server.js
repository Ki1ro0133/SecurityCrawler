const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const XianzhiCrawler = require('./src/XianzhiCrawler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/papers', express.static(path.join(__dirname, 'papers')));

let crawler = null;
let latestArticles = [];

function listArticlesFromDisk() {
  const papersDir = path.join(__dirname, 'papers');
  if (!fs.existsSync(papersDir)) return [];
  const files = fs.readdirSync(papersDir).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const fullPath = path.join(papersDir, f);
    let title = f.replace(/\.md$/, '');
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const m = content.match(/^#\s+(.+)$/m);
      if (m) title = m[1].trim();
    } catch {}
    return { fileName: f, title };
  });
}

io.on('connection', (socket) => {
  socket.emit('init', { articles: latestArticles, files: listArticlesFromDisk() });
});

app.get('/api/articles', (req, res) => {
  res.json({ articles: latestArticles, files: listArticlesFromDisk() });
});

app.post('/api/crawl/start', async (req, res) => {
  if (crawler) return res.status(409).json({ message: 'Crawler already running' });
  const options = req.body || {};
  latestArticles = [];
  crawler = new XianzhiCrawler({
    fetchFullContent: options.fetchFullContent !== false,
    maxPages: Number(options.maxPages) > 0 ? Number(options.maxPages) : 3,
    imagesOnly: !!options.imagesOnly,
    image: !!options.image,
    startDate: options.startDate,
    endDate: options.endDate,
    targetDate: options.targetDate,
    concurrency: Number(options.concurrency) > 0 ? Number(options.concurrency) : 3,
    onUpdate: (event, payload) => {
      if (event === 'article_saved' && payload && payload.article) {
        latestArticles.push(payload.article);
      }
      io.emit(event, payload);
    }
  });
  res.json({ message: 'Crawler started' });
  try {
    await crawler.run();
  } catch (e) {
    io.emit('failure', { title: '运行出错', error: String(e && e.message ? e.message : e) });
  } finally {
    crawler = null;
  }
});

app.post('/api/crawl/stop', async (req, res) => {
  if (!crawler) return res.status(400).json({ message: 'No crawler running' });
  crawler.aborted = true;
  res.json({ message: 'Stopping crawler' });
});

app.delete('/api/articles/:fileName', (req, res) => {
  const fileName = req.params.fileName;
  const papersDir = path.join(__dirname, 'papers');
  const fullPath = path.join(papersDir, fileName);
  try {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    io.emit('article_deleted', { fileName });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`GUI server running at http://localhost:${PORT}/`);
});
