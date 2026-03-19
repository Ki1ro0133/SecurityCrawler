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
  if (/^https:\/\/www\.ctfiot\.com\/go\/\?url=/i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      const encoded = parsed.searchParams.get('url');
      if (encoded) {
        const decoded = Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8').trim();
        if (decoded) return decoded;
      }
    } catch (_) {
      return normalized;
    }
  }
  return normalized;
}

function isPlaceholderImage(url) {
  return /\/wp-content\/themes\/onenav\/images\/t\.png$/i.test(url || '');
}

function imageMarkdown(node) {
  const src = normalizeUrl(node.getAttribute('data-src') || node.getAttribute('src') || '');
  if (!src || isPlaceholderImage(src)) return '';
  const alt = escapeMarkdown((node.getAttribute('alt') || '').trim());
  return `![${alt}](${src})`;
}

function looksLikePythonCode(text) {
  return /(^#!\/usr\/bin\/env python|^\s*(from|import|def|class)\s)/m.test(text || '');
}

function normalizePythonLikeCode(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      const match = line.match(/^( *)(.*)$/);
      const rawIndent = match ? match[1].length : 0;
      let body = match ? match[2] : line;

      if (rawIndent > 0) {
        const normalizedIndent = ' '.repeat(Math.ceil(rawIndent / 2) * 4);
        line = `${normalizedIndent}${body}`;
      } else {
        line = body;
      }

      return line
        .replace(/([)\]"'])(?=(for|if|in|not|is|as|and|or)\b)/g, '$1 ')
        .replace(/\b(not|in|is|and|or|as)(?=\()/g, '$1 ')
        .replace(/\)(?=(not|in|is|as)\b)/g, ') ')
        .replace(/\](?=for\b)/g, '] ')
        .replace(/\b(for|if|while|with|return|raise|global|import|from|def|class|except|elif|assert)(?=[A-Za-z_])/g, '$1 ');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function extractPreformattedText(node) {
  const clone = node.cloneNode(true);
  const target = clone.querySelector('code') || clone;
  const rawLines = [];
  let currentLine = '';

  const needsTokenSpace = (previous, next) => {
    const prev = previous.slice(-1);
    const first = next[0];

    if (!prev || !first) return false;
    if (/\s/.test(prev) || /^\s/.test(next)) return false;
    if (/[([{'"`]/.test(prev)) return false;
    if (/[)\]}.,;:]/.test(first)) return false;

    return /[\w\u4e00-\u9fff]/.test(prev) && /[\w\u4e00-\u9fff]/.test(first);
  };

  for (const child of Array.from(target.childNodes)) {
    if (child.nodeType === 1 && child.tagName.toLowerCase() === 'br') {
      rawLines.push(currentLine);
      currentLine = '';
      continue;
    }

    const text = String(child.textContent || '').replace(/\u00A0/g, ' ');
    if (!text) {
      rawLines.push(currentLine);
      currentLine = '';
      continue;
    }

    if (needsTokenSpace(currentLine, text)) {
      currentLine += ' ';
    }
    currentLine += text;
  }

  if (currentLine || !rawLines.length) {
    rawLines.push(currentLine);
  }

  const output = rawLines
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');

  const normalized = output
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  return looksLikePythonCode(normalized) ? normalizePythonLikeCode(normalized) : normalized;
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
    if (!href) return text;
    if (!text || text === href) return `<${href}>`;
    return `[${text}](${href})`;
  }
  if (tag === 'strong' || tag === 'b') return children ? `**${children}**` : '';
  if (tag === 'em' || tag === 'i') return children ? `*${children}*` : '';
  if (tag === 'code') {
    const code = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  }
  if (tag === 'span' || tag === 'small' || tag === 'sup' || tag === 'sub' || tag === 'mark') {
    return children;
  }
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

  if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
  if (tag === 'img') {
    const image = imageMarkdown(node);
    return image ? `${image}\n\n` : '';
  }
  if (tag === 'pre') {
    const code = extractPreformattedText(node);
    return code ? `\n\`\`\`\n${code}\n\`\`\`\n\n` : '';
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
  if (tag === 'section' || tag === 'div' || tag === 'article' || tag === 'header') {
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
      '.article-copyright',
      '.post-copyright',
      '.article-tags',
      '.single-tags',
      '.post-tags',
      '.related-posts',
      '.post-nav',
      '.panel-footer',
      '[data-immersive-translate-translation-element-mark]',
      '.immersive-translate-target-wrapper',
      '.immersive-translate-target-translation-block-wrapper',
      '.immersive-translate-target-translation-inline-wrapper',
      '[class*="immersive-translate-target"]',
      '[class*="immersive-translate-translation"]',
    ].join(','))
    .forEach((node) => node.remove());
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
