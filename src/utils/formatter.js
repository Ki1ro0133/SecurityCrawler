const crypto = require('crypto');

function sha1(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

function generateFileName(article) {
  const safeTitle = (article.title || '').trim();
  let fileName = safeTitle
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\s()（）\[\]【】]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 80);
  if (!fileName) {
    const linkHash = sha1(String(article.link || 'unknown')).slice(0, 12);
    fileName = `article_${linkHash}`;
  }
  return `${fileName}.md`;
}

function generateSingleArticleMarkdown(article, siteMeta = {}) {
  const sourceName = siteMeta.name || article.site || '站点';
  const safeTitle = (article.title || '未知标题').trim();
  let markdown = `# ${safeTitle}\n\n`;

  markdown += `> 站点: ${sourceName}  \n`;
  markdown += `> 分类: ${article.category || ''}  \n`;
  markdown += `> 作者: ${article.author || ''}  \n`;
  markdown += `> 发布时间: ${article.publishTime || ''}  \n`;
  markdown += `> 原文链接: ${article.link || ''}  \n`;
  markdown += `> 爬取时间: ${new Date(article.extractedAt).toLocaleString('zh-CN')}  \n\n`;

  if (article.content && article.content) {
    const formattedContent = article.content;
    markdown += formattedContent + '\n\n';
  } else {
    markdown += `## 📖 文章内容\n\n`;
    markdown += `> 暂无完整内容，请点击原文链接查看。\n\n`;
  }

  markdown += `---\n\n`;
  markdown += `> 本文档由 ${sourceName} 爬虫插件自动生成  \n`;
  markdown += `> 原文链接: ${article.link || ''}  \n`;
  markdown += `> 爬取时间: ${new Date(article.extractedAt).toLocaleString('zh-CN')}  \n`;

  const parts = markdown.split(/(```[\s\S]*?```)/g);
  const blankLikeRun = /(?:^[\s\u00A0\u3000\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF]*\r?\n){2,}/gm;
  const normalizedMarkdown = parts
    .map(p => (p.startsWith('```')
      ? p
      : p
        .replace(/\r\n?/g, '\n')
        .replace(blankLikeRun, '\n\n')
    ))
    .join('');
  return normalizedMarkdown;
}

function generateIndexMarkdown(articles, baseUrl, generateFileNameFn = generateFileName, siteMeta = {}) {
  const sortedArticles = [...articles].sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));
  const sourceName = siteMeta.name || '站点';
  const sourceUrl = siteMeta.baseUrl || baseUrl || '';

  let markdown = `# ${sourceName} 文章合集\n\n`;
  markdown += `> 🕒 爬取时间: ${new Date().toLocaleString('zh-CN')}\n`;
  markdown += `> 📊 文章数量: ${articles.length} 篇\n`;
  markdown += sourceUrl
    ? `> 🔗 来源: [${sourceName}](${sourceUrl})\n\n`
    : `> 🔗 来源: ${sourceName}\n\n`;

  const categoryStats = {};
  articles.forEach(article => {
    const cat = article.category || '未分类';
    categoryStats[cat] = (categoryStats[cat] || 0) + 1;
  });

  markdown += `## 📊 分类统计\n\n`;
  Object.entries(categoryStats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([category, count]) => {
      markdown += `- **${category}**: ${count} 篇\n`;
    });
  markdown += `\n---\n\n`;

  markdown += `## 📚 文章列表\n\n`;
  markdown += `| 序号 | 标题 | 分类 | 作者 | 发布时间 | 文件 |\n`;
  markdown += `|------|------|------|------|----------|------|\n`;

  sortedArticles.forEach((article, index) => {
    const fileName = generateFileNameFn(article);
    const safeTitle = (article.title || '未知标题').trim();
    const shortTitle = safeTitle.length > 50 ? safeTitle.substring(0, 50) + '...' : safeTitle;
    markdown += `| ${index + 1} | [${shortTitle}](papers/${fileName}) | ${article.category || '未分类'} | ${article.author || '未知'} | ${article.publishTime || '未知'} | [📄](papers/${fileName}) |\n`;
  });

  markdown += `\n---\n\n`;
  markdown += `> 💡 提示: 点击标题或文件链接可以查看具体文章内容\n`;

  return markdown;
}

module.exports = {
  generateFileName,
  generateSingleArticleMarkdown,
  generateIndexMarkdown,
};
