const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeArticleMarkdown(article, baseDir, generateSingleArticleMarkdown, generateFileName) {
  const papersDir = path.join(baseDir, 'papers');
  ensureDir(papersDir);

  const fileName = generateFileName(article);
  const filePath = path.join(papersDir, fileName);
  const articleMarkdown = generateSingleArticleMarkdown(article);

  if (fs.existsSync(filePath)) {
    return { fileName, wrote: false };
  }

  fs.writeFileSync(filePath, articleMarkdown, 'utf8');
  return { fileName, wrote: true };
}

function writeRealtimeSummary(articles, baseUrl, generateFileName, baseDir) {
  const summaryPath = path.join(baseDir, 'SUMMARY-REALTIME.md');
  const { generateIndexMarkdown } = require('./formatter');
  const summaryContent = generateIndexMarkdown(articles, baseUrl, generateFileName);
  fs.writeFileSync(summaryPath, summaryContent, 'utf8');
  return summaryPath;
}

function writeFinalSummaryAndFailures(articles, baseUrl, failures, baseDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalIndexPath = path.join(baseDir, 'SUMMARY-' + timestamp + '.md');
  const { generateIndexMarkdown } = require('./formatter');
  const { generateFileName } = require('./formatter');
  const indexContent = generateIndexMarkdown(articles, baseUrl, generateFileName);
  fs.writeFileSync(finalIndexPath, indexContent, 'utf8');

  let failPath = null;
  if (failures && failures.length) {
    failPath = path.join(baseDir, `failures-${timestamp}.json`);
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2), 'utf8');
  }

  return { finalIndexPath, failPath };
}

module.exports = {
  writeArticleMarkdown,
  writeRealtimeSummary,
  writeFinalSummaryAndFailures,
};