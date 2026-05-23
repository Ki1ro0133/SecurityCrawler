const fs = require('fs');
const path = require('path');
const {
  generateFileName,
  generateIndexMarkdown,
  generateSingleArticleMarkdown,
} = require('./formatter');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeArticleMarkdown({ article, outputDir, siteMeta }) {
  const papersDir = path.join(outputDir, 'papers');
  ensureDir(papersDir);

  const fileName = generateFileName(article);
  const filePath = path.join(papersDir, fileName);
  const articleMarkdown = generateSingleArticleMarkdown(article, siteMeta);

  const previousContent = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : null;
  const hasIncomingContent = String(article && article.content ? article.content : '').trim().length > 0;
  const previousWasPlaceholder = previousContent
    ? previousContent.includes('> 暂无完整内容，请点击原文链接查看。')
    : false;

  if (previousContent === articleMarkdown) {
    return { fileName, wrote: false };
  }

  if (previousContent && !previousWasPlaceholder && !hasIncomingContent) {
    return { fileName, wrote: false };
  }

  fs.writeFileSync(filePath, articleMarkdown, 'utf8');
  return { fileName, wrote: true };
}

function writeArticlesManifest({ articles, outputDir }) {
  const manifestPath = path.join(outputDir, 'articles.json');
  ensureDir(outputDir);
  const serializedArticles = (articles || []).map((article) => ({
    site: article.site,
    title: article.title || '',
    fileName: article.fileName || '',
    category: article.category || '',
    author: article.author || '',
    publishTime: article.publishTime || '',
    link: article.link || '',
    extractedAt: article.extractedAt || '',
  }));
  fs.writeFileSync(manifestPath, JSON.stringify(serializedArticles, null, 2), 'utf8');
  return manifestPath;
}

function writeFinalSummaryAndFailures({ articles, failures, outputDir, siteMeta }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalIndexPath = path.join(outputDir, `SUMMARY-${timestamp}.md`);
  ensureDir(outputDir);
  const indexContent = generateIndexMarkdown(articles, siteMeta.baseUrl, generateFileName, siteMeta);
  fs.writeFileSync(finalIndexPath, indexContent, 'utf8');

  let failPath = null;
  if (failures && failures.length) {
    failPath = path.join(outputDir, `failures-${timestamp}.json`);
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2), 'utf8');
  }

  return { finalIndexPath, failPath };
}

module.exports = {
  writeArticlesManifest,
  writeArticleMarkdown,
  writeFinalSummaryAndFailures,
};
