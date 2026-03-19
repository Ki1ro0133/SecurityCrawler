function convertHtmlToMarkdown(html) {
  if (!html) return '';

  // TODO: 将这里替换为目标站点专用的 HTML -> Markdown 转换逻辑。
  // 最小模板先返回原始 HTML，方便开发者快速接线和调试。
  return String(html).trim();
}

module.exports = {
  convertHtmlToMarkdown,
};
