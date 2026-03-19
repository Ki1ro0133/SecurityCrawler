const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getDataDir(baseDir) {
  return path.join(baseDir, 'data');
}

function getSiteOutputDir(baseDir, siteId) {
  return path.join(getDataDir(baseDir), siteId);
}

function getSitePapersDir(baseDir, siteId) {
  return path.join(getSiteOutputDir(baseDir, siteId), 'papers');
}

function getSiteArticlesManifestPath(baseDir, siteId) {
  return path.join(getSiteOutputDir(baseDir, siteId), 'articles.json');
}

function ensureSiteDirs(baseDir, siteId) {
  const outputDir = getSiteOutputDir(baseDir, siteId);
  const papersDir = getSitePapersDir(baseDir, siteId);
  const imagesDir = path.join(papersDir, 'images');

  ensureDir(outputDir);
  ensureDir(papersDir);
  ensureDir(imagesDir);

  return { outputDir, papersDir, imagesDir };
}

function listArticlesFromDisk(baseDir, siteId) {
  const papersDir = getSitePapersDir(baseDir, siteId);
  if (!fs.existsSync(papersDir)) return [];

  return fs.readdirSync(papersDir)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => {
      const fullPath = path.join(papersDir, fileName);
      let title = fileName.replace(/\.md$/, '');

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const heading = content.match(/^#\s+(.+)$/m);
        if (heading) title = heading[1].trim();
      } catch (_) {}

      return {
        site: siteId,
        fileName,
        title,
      };
    });
}

function normalizeRecoveredArticle(siteId, article = {}) {
  return {
    site: siteId,
    title: article.title || '',
    fileName: article.fileName || '',
    category: article.category || '',
    author: article.author || '',
    publishTime: article.publishTime || '',
    link: article.link || '',
    extractedAt: article.extractedAt || '',
  };
}

function parseArticleFileMetadata(baseDir, siteId, fileName) {
  const fullPath = path.join(getSitePapersDir(baseDir, siteId), fileName);
  if (!fs.existsSync(fullPath)) return null;

  const content = fs.readFileSync(fullPath, 'utf8');
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const categoryMatch = content.match(/^>\s*分类:\s*(.+?)\s*$/m);
  const authorMatch = content.match(/^>\s*作者:\s*(.+?)\s*$/m);
  const publishTimeMatch = content.match(/^>\s*发布时间:\s*(.+?)\s*$/m);
  const linkMatch = content.match(/^>\s*原文链接:\s*(.+?)\s*$/m);
  const extractedAtMatch = content.match(/^>\s*爬取时间:\s*(.+?)\s*$/m);

  return {
    title: titleMatch ? titleMatch[1].trim() : fileName.replace(/\.md$/, ''),
    category: categoryMatch ? categoryMatch[1].trim() : '',
    author: authorMatch ? authorMatch[1].trim() : '',
    publishTime: publishTimeMatch ? publishTimeMatch[1].trim() : '',
    link: linkMatch ? linkMatch[1].trim() : '',
    extractedAt: extractedAtMatch ? extractedAtMatch[1].trim() : '',
  };
}

function readArticlesManifest(baseDir, siteId) {
  const manifestPath = getSiteArticlesManifestPath(baseDir, siteId);
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(parsed)) return null;
    return parsed.map((article) => normalizeRecoveredArticle(siteId, article));
  } catch (_) {
    return null;
  }
}

function listArticlesWithMetadata(baseDir, siteId) {
  return listArticlesFromDisk(baseDir, siteId).map((file) => {
    const metadata = parseArticleFileMetadata(baseDir, siteId, file.fileName) || {};
    return {
      site: siteId,
      title: metadata.title || file.title,
      fileName: file.fileName,
      category: metadata.category || '',
      author: metadata.author || '',
      publishTime: metadata.publishTime || '',
      link: metadata.link || '',
      extractedAt: metadata.extractedAt || '',
    };
  });
}

function listRecoveredArticles(baseDir, siteId) {
  const manifestArticles = readArticlesManifest(baseDir, siteId);
  if (manifestArticles && manifestArticles.length) {
    return manifestArticles;
  }
  return listArticlesWithMetadata(baseDir, siteId);
}

function deleteArticleFile(baseDir, siteId, fileName) {
  const safeFileName = path.basename(fileName);
  const papersDir = getSitePapersDir(baseDir, siteId);
  const fullPath = path.join(papersDir, safeFileName);

  if (!fullPath.startsWith(papersDir)) {
    throw new Error('非法文件路径');
  }

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

module.exports = {
  deleteArticleFile,
  ensureDir,
  ensureSiteDirs,
  getDataDir,
  getSiteOutputDir,
  getSitePapersDir,
  getSiteArticlesManifestPath,
  listArticlesFromDisk,
  listRecoveredArticles,
  readArticlesManifest,
};
