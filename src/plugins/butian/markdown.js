const { JSDOM } = require('jsdom');

function decodeHtmlEntities(text) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const { document } = dom.window;
  let current = String(text || '');

  for (let i = 0; i < 3; i += 1) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = current;
    const decoded = textarea.value || '';
    if (decoded === current) break;
    current = decoded;
  }

  return current;
}

function normalizeMarkdown(markdown) {
  return String(markdown || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\u200C/g, '')
    .replace(/\u200D/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convertHtmlToMarkdown(rawMarkdown) {
  if (!rawMarkdown) return '';
  return normalizeMarkdown(decodeHtmlEntities(rawMarkdown));
}

module.exports = {
  convertHtmlToMarkdown,
};
