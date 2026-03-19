const { JSDOM } = require('jsdom');

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ');
}

function escapeMarkdown(text) {
  return normalizeWhitespace(text)
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]])/g, '\\$1');
}

function normalizeUrl(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return '';
  if (normalized.startsWith('//')) return `https:${normalized}`;
  return normalized;
}

function inferCodeLanguage(node) {
  if (!node) return '';

  const candidates = [
    node.getAttribute('data-language'),
    node.getAttribute('language'),
    node.className,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const match = String(candidate).match(/(?:language-|lang-)([a-z0-9#+-]+)/i);
    const raw = (match ? match[1] : candidate).toLowerCase().trim();
    if (!raw) continue;
    if (raw === 'shell') return 'bash';
    if (['plain', 'plaintext', 'text'].includes(raw)) return '';
    return raw;
  }

  return '';
}

function imageMarkdown(node) {
  const src = normalizeUrl(node.getAttribute('data-src') || node.getAttribute('src') || '');
  if (!src) return '';
  const alt = escapeMarkdown((node.getAttribute('alt') || '').trim());
  return `![${alt}](${src})`;
}

function extractPreformattedText(node) {
  return String(node.textContent || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function inlineMarkdown(node) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeMarkdown(node.textContent || '');
  if (node.nodeType !== 1) return '';

  const tag = node.tagName.toLowerCase();
  const children = Array.from(node.childNodes).map(inlineMarkdown).join('');

  if (tag === 'br') return '  \n';
  if (tag === 'img') return imageMarkdown(node);
  if (tag === 'a') {
    const href = normalizeUrl(node.getAttribute('href'));
    const text = children.trim() || escapeMarkdown(node.textContent || '');
    if (!href || href.startsWith('#toc_')) return text;
    if (!text || text === href) return `<${href}>`;
    return `[${text}](${href})`;
  }
  if (tag === 'strong' || tag === 'b') return children ? `**${children}**` : '';
  if (tag === 'em' || tag === 'i') return children ? `*${children}*` : '';
  if (tag === 'code') {
    const code = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  }
  if (['span', 'small', 'sup', 'sub', 'mark'].includes(tag)) return children;

  return children;
}

function tableMarkdown(node) {
  const rows = Array.from(node.querySelectorAll('tr'));
  if (!rows.length) return '';

  const matrix = rows
    .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => {
      const text = Array.from(cell.childNodes).map(inlineMarkdown).join('').trim();
      return text.replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
    }))
    .filter((cells) => cells.length > 0);

  if (!matrix.length) return '';

  const width = Math.max(...matrix.map((cells) => cells.length));
  const normalizedRows = matrix.map((cells) => cells.concat(Array(width - cells.length).fill(' ')));
  const header = normalizedRows[0];
  const separator = Array(width).fill('---');
  const bodyRows = normalizedRows.slice(1);

  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...bodyRows.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
}

function listItemMarkdown(node, depth, ordered, index) {
  const marker = ordered ? `${index + 1}. ` : '- ';
  const prefix = '  '.repeat(depth);
  const parts = [];

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 1 && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
      const nested = blockMarkdown(child, depth + 1).trimEnd();
      if (nested) parts.push(`\n${nested}`);
      continue;
    }

    const inline = inlineMarkdown(child);
    if (inline) {
      parts.push(inline);
      continue;
    }

    const block = blockMarkdown(child, depth + 1).trim();
    if (block) parts.push(block);
  }

  const content = parts.join('').trim();
  return `${prefix}${marker}${content}`;
}

function blockMarkdown(node, depth = 0) {
  if (!node) return '';
  if (node.nodeType === 3) {
    const text = normalizeWhitespace(node.textContent || '').trim();
    return text ? `${escapeMarkdown(text)}\n\n` : '';
  }
  if (node.nodeType !== 1) return '';

  const tag = node.tagName.toLowerCase();

  if (['script', 'style', 'noscript'].includes(tag)) return '';
  if (tag === 'img') {
    const image = imageMarkdown(node);
    return image ? `${image}\n\n` : '';
  }
  if (tag === 'pre') {
    const codeNode = node.querySelector('code') || node;
    const code = extractPreformattedText(codeNode);
    const language = inferCodeLanguage(codeNode);
    return code ? `\n\`\`\`${language}\n${code}\n\`\`\`\n\n` : '';
  }
  if (tag === 'table') {
    const table = tableMarkdown(node);
    return table ? `${table}\n\n` : '';
  }
  if (tag === 'hr') return '\n---\n\n';
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const text = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
    return text ? `${'#'.repeat(level)} ${text}\n\n` : '';
  }
  if (tag === 'blockquote') {
    const content = Array.from(node.childNodes).map((child) => blockMarkdown(child, depth)).join('').trim();
    if (!content) return '';
    return `${content.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n`;
  }
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    const items = Array.from(node.children)
      .filter((child) => child.tagName && child.tagName.toLowerCase() === 'li')
      .map((li, index) => listItemMarkdown(li, depth, ordered, index))
      .join('\n');
    return items ? `${items}\n\n` : '';
  }
  if (tag === 'figure') {
    const blocks = [];
    const image = node.querySelector('img');
    if (image) {
      const imageLine = imageMarkdown(image);
      if (imageLine) blocks.push(imageLine);
    }
    const caption = node.querySelector('figcaption');
    if (caption) {
      const captionText = Array.from(caption.childNodes).map(inlineMarkdown).join('').trim();
      if (captionText) blocks.push(`_${captionText}_`);
    }
    return blocks.length ? `${blocks.join('\n\n')}\n\n` : '';
  }
  if (tag === 'p') {
    const text = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
    if (!text) return '';
    return /^https?:\/\/\S+$/i.test(text) ? `<${text}>\n\n` : `${text}\n\n`;
  }
  if (['section', 'div', 'article', 'header', 'tbody', 'thead', 'tr', 'td', 'th'].includes(tag)) {
    return Array.from(node.childNodes).map((child) => blockMarkdown(child, depth)).join('');
  }
  if (tag === 'figcaption') {
    const text = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
    return text ? `_${text}_\n\n` : '';
  }

  const inline = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
  if (inline) return `${inline}\n\n`;

  return Array.from(node.childNodes).map((child) => blockMarkdown(child, depth)).join('');
}

function stripNoise(document) {
  document.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
  document
    .querySelectorAll([
      '#catalogue-container',
      '.author-card',
      '.comment-table',
      '.comment-footer',
      '.comment-box',
      '.other-panel',
      '.introduce',
      '[data-immersive-translate-translation-element-mark]',
      '.immersive-translate-target-wrapper',
      '.immersive-translate-target-translation-block-wrapper',
      '.immersive-translate-target-translation-inline-wrapper',
      '[class*="immersive-translate-target"]',
      '[class*="immersive-translate-translation"]',
    ].join(','))
    .forEach((node) => node.remove());

  document.querySelectorAll('h1 a[href^="#toc_"], h2 a[href^="#toc_"], h3 a[href^="#toc_"], h4 a[href^="#toc_"], h5 a[href^="#toc_"], h6 a[href^="#toc_"]').forEach((anchor) => {
    const textNode = document.createTextNode(anchor.textContent || '');
    anchor.replaceWith(textNode);
  });
}

function convertHtmlToMarkdown(html) {
  if (!html) return '';

  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const { document } = dom.window;

  document.querySelectorAll('img').forEach((img) => {
    const dataSrc = img.getAttribute('data-src');
    if (dataSrc) img.setAttribute('src', dataSrc);
  });

  stripNoise(document);

  return Array.from(document.body.childNodes)
    .map((node) => blockMarkdown(node))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  convertHtmlToMarkdown,
};
