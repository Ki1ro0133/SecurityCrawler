const { JSDOM } = require('jsdom');

function escapeMarkdown(text) {
  if (!text) return '';
  let out = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...');
  out = out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return out;
}

function cleanHtmlTags(html, preserveWhitespace = false) {
  if (!html) return '';
  let cleaned = html
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<[^>]+>/g, '');
  if (!preserveWhitespace) {
    cleaned = cleaned
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }
  return cleaned.trim();
}

function getElementAttributes(element) {
  const attrs = {};
  for (let attr of element.attributes) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

function extractCodeFromCard(content, attributes = {}) {
  if (!content) return '';
  let language = '';
  let codeContent = '';
  try {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${content}</body></html>`);
    const document = dom.window.document;
    const codeblockElement = document.querySelector('[data-codeblock-mode]');
    if (codeblockElement) {
      language = codeblockElement.getAttribute('data-codeblock-mode') || '';
    }
    if (!language) {
      const contentElement = document.querySelector('[data-language]');
      if (contentElement) {
        language = contentElement.getAttribute('data-language') || '';
        // normalize language
        const l = (language || '').toLowerCase();
        if (l === 'shell') language = 'bash';
        else if (l === 'plain' || l === 'plaintext' || l === 'text') language = '';
        else language = l;
      }
    }
    const codeLines = document.querySelectorAll('.cm-line');
    if (codeLines.length > 0) {
      const lines = [];
      codeLines.forEach((line) => {
        let lineText = '';
        const walkNodes = (node) => {
          if (node.nodeType === 3) {
            lineText += node.textContent;
          } else if (node.nodeType === 1) {
            if (node.tagName.toLowerCase() === 'br') return;
            for (let child of node.childNodes) walkNodes(child);
          }
        };
        for (let child of line.childNodes) walkNodes(child);
        lines.push(lineText || '');
      });
      codeContent = lines.join('\n');
    } else {
      // robust fallback: try to extract lines from .cm-content children
      const cmContent = document.querySelector('.cm-content');
      if (cmContent) {
        const lines = [];
        const collectText = (node) => {
          let out = '';
          const walk = (n) => {
            if (n.nodeType === 3) {
              out += n.textContent;
            } else if (n.nodeType === 1) {
              if (n.tagName.toLowerCase() === 'br') return;
              for (let c of n.childNodes) walk(c);
            }
          };
        
          walk(node);
          return out;
        };
        for (let child of cmContent.childNodes) {
          if (child.nodeType === 1) {
            const cls = child.getAttribute('class') || '';
            if (cls.includes('cm-gutter')) continue;
            lines.push(collectText(child));
          } else if (child.nodeType === 3) {
            const t = child.textContent || '';
            if (t.trim()) lines.push(t);
          }
        }
        codeContent = lines.join('\n');
      } else {
        const fallback =
          document.querySelector('.ne-codeblock-inner') ||
          document.querySelector('pre code') ||
          document.querySelector('pre') ||
          document.querySelector('code');
        if (fallback) codeContent = fallback.textContent || '';
      }
    }
  } catch (error) {
    codeContent = cleanHtmlTags(content, true);
    const languageMatch = content.match(/data-codeblock-mode="([^"]+)"/i) || content.match(/data-language="([^"]+)"/i);
    if (languageMatch) {
      const l = languageMatch[1].toLowerCase();
      if (l === 'shell') language = 'bash';
      else if (l === 'plain' || l === 'plaintext' || l === 'text') language = '';
      else language = l;
    }
  }
  codeContent = codeContent
    .replace(/\u200B/g, '')
    .replace(/\r\n?/g, '\n');
  if (codeContent.length > 0) {
    return `\n\
\`\`\`${language}\n${codeContent}\n\`\`\`\n\n`;
  }
  return '';
}

function convertTableToMarkdown(content) {
  if (!content) return '';
  try {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><table class="__root">${content}</table></body></html>`);
    const document = dom.window.document;
    const rootTable = document.querySelector('table.__root');
    if (!rootTable) return '';
    const rows = rootTable.querySelectorAll('tr, .ne-tr');
    if (rows.length === 0) {
      const cleanContent = cleanHtmlTags(content);
      return cleanContent ? `\n\`\`\`\n${cleanContent}\n\`\`\`\n` : '';
    }
    const escapeCell = (s) => {
      return (s || '')
        .replace(/\u200B|\uFEFF/g, '')
        .replace(/\u00A0/g, ' ')
        .replace(/\r\n?/g, '\n')
        .replace(/\|/g, '\\|')
        .split('\n')
        .map(line => line.trimEnd())
        .join('<br>');
    };
    let markdown = '';
    let headerEmitted = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = row.querySelectorAll('th, td, .ne-td');
      if (cells.length === 0) continue;
      const hasTh = row.querySelectorAll('th').length > 0;
      const isHeaderRow = hasTh || (!headerEmitted && i === 0);
      const cellContents = [];
      for (let j = 0; j < cells.length; j++) {
        const cell = cells[j];
        const contentDiv = cell.querySelector('.ne-td-content');
        let cellMd = '';
        const collect = (node) => {
          if (!node) return;
          for (let child of node.childNodes) {
            cellMd += convertDomNodeToMarkdown(child);
          }
        };
        if (contentDiv) collect(contentDiv); else collect(cell);
        cellMd = cellMd.replace(/\n{2,}/g, '\n');
        cellContents.push(escapeCell(cellMd) || ' ');
      }
      markdown += '| ' + cellContents.join(' | ') + ' |\n';
      if (!headerEmitted && isHeaderRow) {
        const separator = cellContents.map(() => '---').join(' | ');
        markdown += '| ' + separator + ' |\n';
        headerEmitted = true;
      }
    }
    return markdown || `\n\`\`\`\n${cleanHtmlTags(content)}\n\`\`\`\n`;
  } catch (error) {
    const cleanContent = cleanHtmlTags(content);
    return cleanContent ? `\n\`\`\`\n${cleanContent}\n\`\`\`\n` : '';
  }
}

function convertElementToMarkdown(tagName, attributes, content, context = {}) {
  switch (tagName) {
    case 'ne-h1': return `\n# ${content}\n\n`;
    case 'ne-h2': return `\n## ${content}\n\n`;
    case 'ne-h3': return `\n### ${content}\n\n`;
    case 'ne-h4': return `\n#### ${content}\n\n`;
    case 'ne-h5': return `\n##### ${content}\n\n`;
    case 'ne-h6': return `\n###### ${content}\n\n`;
    case 'ne-p': return content ? `${content}\n\n` : '';
    case 'ne-hole': return content;
    case 'ne-alert-hole': {
      // 作为块级容器，保证与周围内容有分隔
      const inner = (content || '').replace(/\n{3,}/g, '\n\n');
      return `\n${inner}\n`;
    }
    case 'ne-alert': {
      // 将告警内容转为 Markdown 引用块，避免行首 “#” 变为标题
      const raw = (content || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u200B\uFEFF]/g, '')
        .replace(/\n{3,}/g, '\n\n');
      const lines = raw.split('\n');
      const quote = lines.map(line => {
        const t = line.replace(/[\s\u00A0]+$/g, '');
        if (!t.trim()) return '>';
        // 保护常见 Markdown 触发符号
        let s = t.replace(/^#/g, '\\#')
                 .replace(/^(-\s)/, '\\$1')
                 .replace(/^(\d+)\.\s/, (m, n) => `\\${n}. `);
        return `> ${s}`;
      }).join('\n');
      return `\n${quote}\n\n`;
    }
    case 'ne-text': {
      let styled = content;
      if (attributes['ne-bold'] === 'true') styled = `**${styled}**`;
      if (attributes['ne-italic'] === 'true') styled = `*${styled}*`;
      if (attributes['ne-code'] === 'true') styled = `\`${styled}\``;
      if (attributes['ne-underline'] === 'true') styled = `<u>${styled}</u>`;
      if (attributes['ne-strikethrough'] === 'true') styled = `~~${styled}~~`;
      return styled;
    }
    case 'ne-code': {
      const raw = content.replace(/\n+/g, ' ');
      const runs = raw.match(/`+/g);
      let fenceLen = 1;
      if (runs && runs.length) fenceLen = Math.max(...runs.map(s => s.length)) + 1;
      const fence = '`'.repeat(fenceLen);
      const needsPadding = raw.startsWith('`') || raw.endsWith('`') || raw.startsWith(' ') || raw.endsWith(' ');
      return needsPadding ? `${fence} ${raw} ${fence}` : `${fence}${raw}${fence}`;
    }
    case 'ne-codeblock': {
      const language = attributes['language'] || '';
      if (context) context.inCodeBlock = true;
      const inner = content;
      if (context) context.inCodeBlock = false;
      return `\n\`\`\`${language}\n${inner}\n\`\`\`\n\n`;
    }
    case 'ne-ul':
    case 'ne-ol':
      return `\n${content}\n`;
    case 'ne-oli':
    case 'ne-li': {
      if (context.parentListType === 'ordered') {
        const index = context.listIndex || 1;
        return `${index}. ${content}\n`;
      }
      return `- ${content}\n`;
    }
    case 'ne-oli-i': return content ? `${content} ` : '';
    case 'ne-oli-c': return content;
    case 'ne-list-symbol': return '';
    case 'ne-card': {
      const cardType = attributes['data-card-type'];
      const cardName = attributes['data-card-name'];
      if (cardName === 'codeblock' || cardType === 'block') {
        return extractCodeFromCard(content, attributes);
      }
      if (content.includes('![')) return `\n${content}\n\n`;
      return `\n> ${content}\n\n`;
    }
    case 'ne-table-hole':
    case 'ne-table-wrap':
    case 'ne-table-inner-wrap':
    case 'ne-table-box': return content;
    case 'ne-table':
    case 'table': return `\n${convertTableToMarkdown(content)}\n\n`;
    case 'ne-tr':
    case 'tr': return content;
    case 'ne-td':
    case 'td':
    case 'th': return content;
    case 'ne-td-content': return content;
    case 'ne-td-break': return '';
    case 'colgroup':
    case 'col':
    case 'tbody':
    case 'thead':
    case 'tfoot': return content;
    case 'br': return '\n';
    case 'a': {
      const href = attributes['href'] || '';
      return href ? `[${content}](${href})` : content;
    }
    case 'img': {
      const src = attributes['src'] || '';
      const alt = attributes['alt'] || '图片';
      return src ? `![${alt}](${src})` : '';
    }
    case 'div': {
      if (attributes['class'] && attributes['class'].includes('ne-image-error')) return '';
    }
    case 'span': {
      const className = attributes['class'] || '';
      if (className.includes('ne-viewer-b-filler') || attributes['ne-filler']) return '';
      if (className.includes('cm-line')) return content;
      if (
        className.includes('cm-editor') ||
        className.includes('cm-scroller') ||
        className.includes('cm-content') ||
        className.includes('cm-gutter') ||
        className.includes('cm-cursor') ||
        className.includes('cm-selection') ||
        className.includes('cm-layer') ||
        className.includes('cm-announced') ||
        className.includes('ne-codeblock-copy') ||
        className.includes('ne-codeblock-inner') ||
        className.includes('ne-card-container') ||
        className.includes('ne-v-codeblock-hold')
      ) {
        return content;
      }
      if (className.includes('ne-code')) {
        const raw = content.replace(/\n+/g, ' ');
        const runs = raw.match(/`+/g);
        let fenceLen = 1;
        if (runs && runs.length) fenceLen = Math.max(...runs.map(s => s.length)) + 1;
        const fence = '`'.repeat(fenceLen);
        const needsPadding = raw.startsWith('`') || raw.endsWith('`') || raw.startsWith(' ') || raw.endsWith(' ');
        return needsPadding ? `${fence} ${raw} ${fence}` : `${fence}${raw}${fence}`;
      }
      if (className.includes('ne-codeblock')) return content;
      return content;
    }
    case 'script':
    case 'style': return '';
    default: return content;
  }
}

function convertDomNodeToMarkdown(node, context = {}) {
  if (!node) return '';
  if (node.nodeType === 3) {
    return escapeMarkdown(node.textContent);
  }
  if (node.nodeType === 1) {
    const tagName = node.tagName.toLowerCase();
    const attributes = getElementAttributes(node);
    if (tagName === 'ne-card' && attributes['data-card-name'] === 'codeblock') {
      return extractCodeFromCard(node.innerHTML, attributes);
    }
    if (tagName === 'ne-table' || tagName === 'table') {
      return `\n${convertTableToMarkdown(node.innerHTML)}\n\n`;
    }
    if (tagName === 'ne-code') {
      const raw = (node.textContent || '').replace(/\n+/g, ' ');
      const runs = raw.match(/`+/g);
      let fenceLen = 1;
      if (runs && runs.length) fenceLen = Math.max(...runs.map(s => s.length)) + 1;
      const fence = '`'.repeat(fenceLen);
      const needsPadding = raw.startsWith('`') || raw.endsWith('`') || raw.startsWith(' ') || raw.endsWith(' ');
      return needsPadding ? `${fence} ${raw} ${fence}` : `${fence}${raw}${fence}`;
    }
    let content = '';
    const childContext = { ...context };
    if (tagName === 'ne-ol' || tagName === 'ol') {
      childContext.parentListType = 'ordered';
      childContext.listIndex = 0;
    } else if (tagName === 'ne-ul' || tagName === 'ul') {
      childContext.parentListType = 'unordered';
    }
    for (let child of node.childNodes) {
      if (child.nodeType === 1) {
        const ctn = child.tagName.toLowerCase();
        if (ctn === 'ne-li' || ctn === 'li' || ctn === 'ne-oli') {
          if (childContext.parentListType === 'ordered') {
            childContext.listIndex = (childContext.listIndex || 0) + 1;
          }
        }
      }
      content += convertDomNodeToMarkdown(child, childContext);
    }
    return convertElementToMarkdown(tagName, attributes, content, context);
  }
  return '';
}

function convertHtmlToMarkdown(html) {
  try {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
    const document = dom.window.document;
    const body = document.body;
    const markdown = convertDomNodeToMarkdown(body);
    return markdown;
  } catch (error) {
    return cleanHtmlTags(html);
  }
}

module.exports = {
  convertHtmlToMarkdown,
  cleanHtmlTags,
};