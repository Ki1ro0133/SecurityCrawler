const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createCrawlerApp } = require('./src/core/app');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const crawlerApp = createCrawlerApp(__dirname);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));

let activeRun = null;
const latestArticlesBySite = new Map();

function getArticlesForSite(site) {
  if (!latestArticlesBySite.has(site)) {
    const recoveredArticles = crawlerApp.recoverArticles(site);
    latestArticlesBySite.set(site, recoveredArticles);
    crawlerApp.writeArticlesManifest(site, recoveredArticles);
  }
  return latestArticlesBySite.get(site) || [];
}

io.on('connection', (socket) => {
  const defaultSite = crawlerApp.getDefaultSite();
  socket.emit('init', {
    defaultSite,
    sites: crawlerApp.listSites(),
    articles: getArticlesForSite(defaultSite),
    files: crawlerApp.listArticles(defaultSite),
  });
});

app.get('/api/sites', (req, res) => {
  res.json({
    defaultSite: crawlerApp.getDefaultSite(),
    sites: crawlerApp.listSites(),
  });
});

app.get('/api/articles', (req, res) => {
  const site = req.query.site || crawlerApp.getDefaultSite();
  try {
    res.json({
      site,
      articles: getArticlesForSite(site),
      files: crawlerApp.listArticles(site),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/crawl/start', async (req, res) => {
  if (activeRun) return res.status(409).json({ message: 'Crawler already running' });
  const options = req.body || {};
  try {
    activeRun = crawlerApp.createRun({
      site: options.site,
      rawOptions: options,
      onEvent: (event, payload) => {
        const site = payload.site;
        if (event === 'run_start') {
          latestArticlesBySite.set(site, []);
        }
        if (event === 'article_saved' && payload && payload.article) {
          const current = latestArticlesBySite.get(site) || [];
          current.push(payload.article);
          latestArticlesBySite.set(site, current);
        }
        io.emit(event, payload);
      },
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  res.json({
    message: 'Crawler started',
    site: activeRun.site,
    siteName: activeRun.plugin.meta.name,
  });

  try {
    await activeRun.runner.run();
  } catch (e) {
    io.emit('failure', {
      site: activeRun.site,
      title: '运行出错',
      error: String(e && e.message ? e.message : e),
    });
  } finally {
    activeRun = null;
  }
});

app.post('/api/crawl/stop', async (req, res) => {
  if (!activeRun) return res.status(400).json({ message: 'No crawler running' });
  if (typeof activeRun.runner.stop === 'function') {
    activeRun.runner.stop();
  }
  res.json({ message: 'Stopping crawler', site: activeRun.site });
});

app.delete('/api/articles/:site/:fileName', (req, res) => {
  const site = req.params.site;
  const fileName = req.params.fileName;
  try {
    crawlerApp.deleteArticle(site, fileName);
    const updatedArticles = getArticlesForSite(site).filter((article) => article.fileName !== fileName);
    latestArticlesBySite.set(site, updatedArticles);
    crawlerApp.writeArticlesManifest(site, updatedArticles);
    io.emit('article_deleted', { site, fileName });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`SecurityCrawler Web UI running at http://localhost:${PORT}/`);
});
