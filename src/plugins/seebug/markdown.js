const { JSDOM } = require('jsdom');

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\u200C/g, '')
    .replace(/\u200D/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n');
}

function escapeMarkdown(text) {
  return normalizeWhitespace(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]])/g, '\\$1');
}

function normalizeUrl(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return '';
  if (normalized.startsWith('//')) return `https:${normalized}`;
  return normalized;
}

function normalizeInlineText(text) {
  return normalizeWhitespace(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

function isNoiseText(text) {
  const normalized = normalizeInlineText(text);
  if (!normalized) return true;
  return [
    'Report issue for preceding element',
    'report issue for preceding element',
  ].includes(normalized);
}

function imageMarkdown(node) {
  const src = normalizeUrl(node.getAttribute('data-src') || node.getAttribute('src') || '');
  if (!src) return '';
  const alt = escapeMarkdown((node.getAttribute('alt') || '').trim());
  return `![${alt}](${src})`;
}

function extractPreformattedText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('button, .copy-btn, .toolbar').forEach((child) => child.remove());

  return normalizeWhitespace(clone.textContent || '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inlineMarkdown(node) {
  if (!node) return '';
  if (node.nodeType === 3) {
    const text = normalizeWhitespace(node.textContent || '');
    return isNoiseText(text) ? '' : escapeMarkdown(text);
  }
  if (node.nodeType !== 1) return '';

  const tag = node.tagName.toLowerCase();
  const children = Array.from(node.childNodes).map(inlineMarkdown).join('');

  if (tag === 'br') return '  \n';
  if (tag === 'img') return imageMarkdown(node);
  if (tag === 'a') {
    const href = normalizeUrl(node.getAttribute('href'));
    const text = children.trim() || escapeMarkdown(node.textContent || '');
    if (!text) return '';
    if (!href) return text;
    if (text === href) return `<${href}>`;
    return `[${text}](${href})`;
  }
  if (tag === 'strong' || tag === 'b') return children ? `**${children}**` : '';
  if (tag === 'em' || tag === 'i') return children ? `*${children}*` : '';
  if (tag === 'code') {
    const code = normalizeInlineText(node.textContent || '');
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  }
  if (tag === 'span' || tag === 'small' || tag === 'sup' || tag === 'sub' || tag === 'mark') {
    return children;
  }

  return children;
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

  const content = normalizeInlineText(parts.join(' '));
  return content ? `${prefix}${marker}${content}` : '';
}

function blockMarkdown(node, depth = 0) {
  if (!node) return '';
  if (node.nodeType === 3) {
    const text = normalizeInlineText(node.textContent || '');
    return text && !isNoiseText(text) ? `${escapeMarkdown(text)}\n\n` : '';
  }
  if (node.nodeType !== 1) return '';

  const tag = node.tagName.toLowerCase();
  const text = normalizeInlineText(node.textContent || '');

  if (isNoiseText(text)) return '';
  if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
  if (tag === 'img') {
    const image = imageMarkdown(node);
    return image ? `${image}\n\n` : '';
  }
  if (tag === 'pre') {
    const code = extractPreformattedText(node);
    return code ? `\n\`\`\`\n${code}\n\`\`\`\n\n` : '';
  }
  if (tag === 'hr') return '\n---\n\n';
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const title = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
    return title ? `${'#'.repeat(level)} ${title}\n\n` : '';
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
      .filter(Boolean)
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
    const content = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
    if (!content || isNoiseText(content)) return '';
    return /^https?:\/\/\S+$/i.test(content) ? `<${content}>\n\n` : `${content}\n\n`;
  }
  if (tag === 'section' || tag === 'div' || tag === 'article' || tag === 'header' || tag === 'main') {
    return Array.from(node.childNodes).map((child) => blockMarkdown(child, depth)).join('');
  }
  if (tag === 'figcaption') {
    const content = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
    return content ? `_${content}_\n\n` : '';
  }

  const inline = Array.from(node.childNodes).map(inlineMarkdown).join('').trim();
  if (inline) return `${inline}\n\n`;

  return Array.from(node.childNodes).map((child) => blockMarkdown(child, depth)).join('');
}

function stripNoise(document) {
  document.querySelectorAll('script, style, noscript, iframe, svg, canvas').forEach((node) => node.remove());
  document
    .querySelectorAll([
      '.article-meta',
      '.meta',
      '.share',
      '.recommend',
      '.related',
      '.related-posts',
      '.post-nav',
      '.toolbar',
      '.copy-btn',
      '.code-toolbar',
      '.advertisement',
      '.ads',
      '.copyright',
      '.article-copyright',
      '[role="button"]',
      '[aria-label*="report issue" i]',
      '[aria-label*="preceding element" i]',
      '[class*="report" i]',
      '[class*="toolbar" i]',
      '[class*="share" i]',
    ].join(','))
    .forEach((node) => node.remove());

  Array.from(document.querySelectorAll('*')).forEach((node) => {
    const text = normalizeInlineText(node.textContent || '');
    if (!text) return;
    if (isNoiseText(text)) {
      node.remove();
    }
  });
}

function postProcess(markdown) {
  return normalizeWhitespace(markdown)
    .replace(/^.*Report issue for preceding element.*$/gm, (line) => line.replace(/Report issue for preceding element.*$/g, '').trim())
    .replace(/^\s*Report issue for preceding element\s*$/gim, '')
    .replace(/\bReport issue for preceding element\b/g, '')
    .replace(/^\s*$/gm, '')
    .replace(/^[∙•·]\s*\\bullet\s*/gm, '- ')
    .replace(/[∙•·]\s*\\bullet\s*/g, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
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

  const markdown = Array.from(document.body.childNodes)
    .map((node) => blockMarkdown(node))
    .join('');

  return postProcess(markdown);
}

module.exports = {
  convertHtmlToMarkdown,
};
