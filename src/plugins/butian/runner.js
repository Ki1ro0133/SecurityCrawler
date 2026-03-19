const { JSDOM } = require('jsdom');
const { convertHtmlToMarkdown } = require('./markdown');

class ButianRunner {
  constructor(context) {
    this.context = context;
    this.baseUrl = context.plugin.baseUrl;
    this.referer = context.plugin.referer;
    this.fetchFullContent = context.options.fetchFullContent !== false;
    this.maxPages = context.options.maxPages || 1;
    this.imagesOnly = !!context.options.imagesOnly;
    this.image = !!context.options.image;
    this.concurrency = Number(context.options.concurrency) > 0 ? Number(context.options.concurrency) : 3;
    this.startDate = context.options.startDate ? new Date(context.options.startDate) : null;
    this.endDate = context.options.endDate ? new Date(context.options.endDate) : null;
    this.targetDate = context.options.targetDate ? new Date(context.options.targetDate) : (this.startDate || null);
    this.articles = [];
    this.failures = [];
    this.aborted = false;
    this._seenKeys = new Set();
  }

  emit(event, payload = {}) {
    this.context.emit(event, payload);
  }

  stop() {
    this.aborted = true;
  }

  async fetchText(url) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': this.referer,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }

    return response.text();
  }

  getPageUrl(pageNumber) {
    if (pageNumber <= 1) return this.baseUrl;
    const url = new URL(this.baseUrl);
    url.searchParams.set('page', String(pageNumber));
    return url.toString();
  }

  normalizeTitle(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeArticleDate(raw) {
    return String(raw || '')
      .replace(/^发布于\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeText(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  parseNumber(raw) {
    const match = String(raw || '').match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  shouldIncludeArticle(article) {
    if (!article.publishTime) return true;

    try {
      const articleDate = new Date(article.publishTime);
      let include = true;
      if (this.startDate) include = include && articleDate >= this.startDate;
      if (this.endDate) include = include && articleDate <= this.endDate;
      if (!this.startDate && !this.endDate && this.targetDate) {
        include = include && articleDate > this.targetDate;
      }
      return include;
    } catch (_) {
      return true;
    }
  }

  getArticleKey(article) {
    return (article.link && article.link.trim()) || `${(article.title || '').trim()}|${article.publishTime || ''}`;
  }

  parseListMeta(metaItems = []) {
    const normalized = metaItems.map((item) => this.normalizeText(item)).filter(Boolean);
    const publishMeta = normalized.find((item) => item.startsWith('发布于 ')) || '';
    const readMeta = normalized.find((item) => item.startsWith('阅读')) || '';
    const author = normalized.find((item) => !item.startsWith('发布于 ') && !item.startsWith('阅读') && /^\d+$/.test(item) === false) || '';

    return {
      author,
      publishTime: this.normalizeArticleDate(publishMeta),
      readCount: this.parseNumber(readMeta),
    };
  }

  parseListPage(html) {
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const cards = Array.from(document.querySelectorAll('.stream-list-item'));

    return cards.map((card) => {
      const titleLink = card.querySelector('h2.title a');
      if (!titleLink) return null;

      const meta = this.parseListMeta(
        Array.from(card.querySelectorAll('.author li')).map((node) => node.textContent || '')
      );

      return {
        site: this.context.site,
        title: this.normalizeTitle(titleLink.textContent || ''),
        link: titleLink.href ? String(titleLink.href).trim() : '',
        category: '',
        author: meta.author,
        publishTime: meta.publishTime,
        extractedAt: new Date().toISOString(),
        sourceMeta: {
          excerpt: this.normalizeText(card.querySelector('.excerpt')?.textContent || ''),
          readCount: meta.readCount,
        },
      };
    }).filter((article) => article && article.link && article.title);
  }

  parseDetailStats(document) {
    const statItems = Array.from(document.querySelectorAll('.post-opt li'))
      .map((node) => this.normalizeText(node.textContent || ''))
      .filter(Boolean);

    return {
      publishTime: this.normalizeArticleDate(statItems.find((item) => item.startsWith('发布于 ')) || ''),
      readCount: this.parseNumber(statItems.find((item) => item.startsWith('阅读')) || ''),
      category: this.normalizeText(
        document.querySelector('.post-opt a[href*="/community/"]')?.textContent
        || document.querySelector('.taglist-inline .tag')?.textContent
        || ''
      ),
    };
  }

  async fetchArticleContent(article) {
    const html = await this.fetchText(article.link);
    const dom = new JSDOM(html);
    const { document } = dom.window;

    const title = this.normalizeTitle(document.querySelector('.widget-article h3.title')?.textContent || article.title || '');
    const quote = this.normalizeText(document.querySelector('.widget-article .quote')?.textContent || '');
    const rawMarkdown = document.querySelector('#md_view_content')?.textContent || '';
    const content = convertHtmlToMarkdown(rawMarkdown);
    const stats = this.parseDetailStats(document);
    const author = this.normalizeText(document.querySelector('.widget-user .media-heading')?.textContent || article.author || '');
    const tags = Array.from(document.querySelectorAll('.taglist-inline .tag'))
      .map((node) => this.normalizeText(node.textContent || ''))
      .filter(Boolean)
      .filter((tag, index, tagsList) => tagsList.indexOf(tag) === index);

    if (!content) {
      throw new Error('未找到文章 Markdown 正文');
    }

    return {
      title,
      category: stats.category || tags.join(', ') || article.category,
      author,
      publishTime: stats.publishTime || article.publishTime,
      content,
      sourceMeta: {
        excerpt: quote || String(article.sourceMeta?.excerpt || '').trim(),
        readCount: stats.readCount || Number(article.sourceMeta?.readCount || 0) || 0,
        tags,
      },
    };
  }

  buildFallbackContent(article) {
    const excerpt = this.normalizeText(article && article.sourceMeta && article.sourceMeta.excerpt ? article.sourceMeta.excerpt : '');
    if (!excerpt) return '';
    return `## 摘要\n\n${excerpt}\n`;
  }

  async persistArticle(article, key) {
    if (this._seenKeys.has(key)) return;

    const normalizedArticle = {
      site: this.context.site,
      title: article.title || '',
      link: article.link || '',
      publishTime: article.publishTime || '',
      category: article.category || '',
      author: article.author || '',
      extractedAt: article.extractedAt || new Date().toISOString(),
      content: article.content || '',
      sourceMeta: article.sourceMeta || {},
    };

    const { fileName } = this.context.services.output.writeArticle(normalizedArticle);
    normalizedArticle.fileName = fileName;
    this._seenKeys.add(key);
    this.articles.push(normalizedArticle);
    this.context.services.output.writeArticlesManifest(this.articles);
    this.emit('article_saved', {
      fileName,
      article: normalizedArticle,
    });
    this.emit('progress', {
      totalSaved: this.articles.length,
    });
  }

  async scrapeArticles() {
    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
      if (this.aborted) break;

      const pageHtml = await this.fetchText(this.getPageUrl(pageNumber));
      const pageArticles = this.parseListPage(pageHtml);
      if (!pageArticles.length) break;

      let index = 0;
      const workers = Array.from({ length: Math.max(1, this.concurrency) }, async () => {
        while (index < pageArticles.length && !this.aborted) {
          const current = pageArticles[index];
          index += 1;

          const key = this.getArticleKey(current);
          if (this._seenKeys.has(key)) continue;

          try {
            if (this.fetchFullContent) {
              try {
                const detail = await this.fetchArticleContent(current);
                current.title = detail.title || current.title;
                current.category = detail.category || current.category;
                current.author = detail.author || current.author;
                current.publishTime = detail.publishTime || current.publishTime;
                current.content = detail.content || this.buildFallbackContent(current);
                current.sourceMeta = {
                  ...(current.sourceMeta || {}),
                  ...(detail.sourceMeta || {}),
                };
              } catch (error) {
                current.content = this.buildFallbackContent(current);
                current.sourceMeta = {
                  ...(current.sourceMeta || {}),
                  detailFetchError: String(error && error.message ? error.message : error),
                };
              }
            }

            if (!this.shouldIncludeArticle(current)) continue;

            await this.persistArticle(current, key);
          } catch (error) {
            const failure = {
              link: current.link,
              title: current.title || '未知标题',
              error: String(error && error.message ? error.message : error),
            };
            this.failures.push(failure);
            this.emit('failure', failure);
          }
        }
      });

      await Promise.all(workers);
    }
  }

  async saveResults() {
    if (!this.articles.length) return;
    this.context.services.output.writeArticlesManifest(this.articles);
    this.context.services.output.writeFinalSummaryAndFailures(this.articles, this.failures || []);
  }

  async run() {
    try {
      this.emit('run_start', {
        imagesOnly: this.imagesOnly,
        maxPages: this.maxPages,
        concurrency: this.concurrency,
        fetchFullContent: this.fetchFullContent,
      });

      if (this.imagesOnly) {
        await this.context.services.images.localize({
          concurrency: this.concurrency,
          referer: this.referer,
        });
        return;
      }

      await this.scrapeArticles();
      await this.saveResults();

      if (this.image && !this.aborted) {
        await this.context.services.images.localize({
          concurrency: this.concurrency,
          referer: this.referer,
        });
      }
    } catch (error) {
      this.emit('failure', {
        title: '运行出错',
        error: String(error && error.message ? error.message : error),
      });
    } finally {
      this.emit('run_complete', {
        imagesOnly: this.imagesOnly,
        totalSaved: this.articles.length,
        failures: this.failures.length,
        aborted: this.aborted,
      });
    }
  }
}

module.exports = ButianRunner;
