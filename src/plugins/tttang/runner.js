const { JSDOM } = require('jsdom');
const { convertHtmlToMarkdown } = require('./markdown');

class TttangRunner {
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

  normalizeText(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeArticleDate(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
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

  parseListPage(html) {
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const cards = Array.from(document.querySelectorAll('.article-list .media.media-list'));

    return cards.map((card) => {
      const titleLink = card.querySelector('a.title');
      if (!titleLink) return null;

      const categories = Array.from(card.querySelectorAll('.comment-footer .badge'))
        .map((node) => this.normalizeText(node.textContent || ''))
        .filter(Boolean);
      const excerptHtml = card.querySelector('.card-text')?.innerHTML || '';

      return {
        site: this.context.site,
        title: this.normalizeTitle(titleLink.textContent || ''),
        link: titleLink.getAttribute('href')
          ? new URL(String(titleLink.getAttribute('href')).trim(), this.baseUrl).toString()
          : '',
        category: categories.join(', '),
        author: this.normalizeText(card.querySelector('.author')?.textContent || ''),
        publishTime: this.normalizeArticleDate(card.querySelector('.time')?.textContent || ''),
        extractedAt: new Date().toISOString(),
        sourceMeta: {
          excerpt: convertHtmlToMarkdown(excerptHtml),
          categories,
        },
      };
    }).filter((article) => article && article.link && article.title);
  }

  async fetchArticleContent(article) {
    const html = await this.fetchText(article.link);
    const dom = new JSDOM(html);
    const { document } = dom.window;

    const articleNode = document.querySelector('article.articles');
    if (!articleNode) {
      throw new Error('未找到文章正文容器');
    }

    const categories = Array.from(document.querySelectorAll('.pull-right .badge.badge-light'))
      .map((node) => this.normalizeText(node.textContent || ''))
      .filter(Boolean);
    const content = convertHtmlToMarkdown(articleNode.innerHTML || '');

    if (!content) {
      throw new Error('文章正文为空');
    }

    return {
      title: this.normalizeTitle(document.querySelector('.product-details h2')?.textContent || article.title || ''),
      category: categories.join(', ') || article.category,
      author: this.normalizeText(document.querySelector('.product-details .author')?.textContent || article.author || ''),
      publishTime: this.normalizeArticleDate(document.querySelector('.product-details .time')?.textContent || article.publishTime || ''),
      content,
      sourceMeta: {
        categories,
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
            } else {
              current.content = this.buildFallbackContent(current);
            }

            if (!current.content) {
              current.content = this.buildFallbackContent(current);
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

module.exports = TttangRunner;
