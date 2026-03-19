const { JSDOM } = require('jsdom');
const { convertHtmlToMarkdown } = require('./markdown');

class CtfiotRunner {
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    return pageNumber <= 1 ? this.baseUrl : `${this.baseUrl}/page/${pageNumber}`;
  }

  normalizeTitle(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeArticleDate(raw) {
    if (!raw) return '';

    const text = String(raw).trim();
    const match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(am|pm)?\s*(\d{1,2}):(\d{2})/i);
    if (!match) return text;

    let [, year, month, day, meridiem, hour, minute] = match;
    let normalizedHour = Number(hour);
    const normalizedMeridiem = (meridiem || '').toLowerCase();

    if (normalizedMeridiem === 'pm' && normalizedHour < 12) normalizedHour += 12;
    if (normalizedMeridiem === 'am' && normalizedHour === 12) normalizedHour = 0;

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(normalizedHour).padStart(2, '0')}:${minute}`;
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
    const cards = Array.from(document.querySelectorAll('.cat_list .list-item.card'));

    return cards.map((card) => {
      const titleLink = card.querySelector('.list-title');
      const categoryLink = card.querySelector('.list-footer a[href^="https://www.ctfiot.com/"]');
      const timeElement = card.querySelector('.list-footer time');
      const descriptionElement = card.querySelector('.list-desc');

      if (!titleLink) return null;

      return {
        site: this.context.site,
        title: this.normalizeTitle(titleLink.getAttribute('title') || titleLink.textContent || ''),
        link: (titleLink.getAttribute('href') || '').trim(),
        category: categoryLink ? (categoryLink.textContent || '').trim() : '',
        author: '',
        publishTime: '',
        extractedAt: new Date().toISOString(),
        sourceMeta: {
          listTimeText: timeElement ? (timeElement.textContent || '').trim() : '',
          description: descriptionElement ? (descriptionElement.textContent || '').trim() : '',
        },
      };
    }).filter(Boolean);
  }

  resolveCategory(document, header, fallbackCategory) {
    const headerCategoryLink = header
      ? header.querySelector('a[href^="https://www.ctfiot.com/"]:not([href*="/author/"])')
      : null;
    if (headerCategoryLink) {
      return (headerCategoryLink.textContent || '').trim();
    }

    const breadcrumbCategoryLink = document.querySelector('nav[aria-label="breadcrumb"] a[rel="category tag"]');
    if (breadcrumbCategoryLink) {
      return (breadcrumbCategoryLink.textContent || '').trim();
    }

    return fallbackCategory || '';
  }

  resolveArticleBody(document) {
    const preferredBody = document.querySelector('.wxsyncmain, .panel-body.single .mdx');
    if (preferredBody) return preferredBody;

    const panelBody = document.querySelector('.panel-body.single');
    if (!panelBody) return null;

    const clone = panelBody.cloneNode(true);
    clone.querySelectorAll('header, .panel-header, .article-copyright').forEach((node) => node.remove());
    return clone;
  }

  async fetchArticleContent(article) {
    const html = await this.fetchText(article.link);
    const dom = new JSDOM(html);
    const { document } = dom.window;

    const header = document.querySelector('.panel-header');
    const title = this.normalizeTitle(header && header.querySelector('h1') ? header.querySelector('h1').textContent : article.title || '');
    const authorLink = header ? header.querySelector('a[href*="/author/"]') : null;
    const publishTimeSpan = header ? header.querySelector('span[title*="年"]') : null;
    const articleBody = this.resolveArticleBody(document);

    if (!articleBody) {
      throw new Error('未找到兼容的文章正文容器');
    }

    articleBody.querySelectorAll('img').forEach((img) => {
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc) img.setAttribute('src', dataSrc);
    });

    const content = convertHtmlToMarkdown(articleBody.innerHTML);

    return {
      title,
      category: this.resolveCategory(document, header, article.category),
      author: authorLink ? (authorLink.textContent || '').trim() : '',
      publishTime: this.normalizeArticleDate(publishTimeSpan ? publishTimeSpan.getAttribute('title') : ''),
      content,
    };
  }

  async scrapeArticles() {
    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber++) {
      if (this.aborted) break;

      const pageUrl = this.getPageUrl(pageNumber);
      const pageHtml = await this.fetchText(pageUrl);
      const pageArticles = this.parseListPage(pageHtml);
      if (!pageArticles.length) break;

      let index = 0;
      const workers = Array.from({ length: Math.max(1, this.concurrency) }, async () => {
        while (index < pageArticles.length && !this.aborted) {
          const current = pageArticles[index++];
          const key = this.getArticleKey(current);
          if (this._seenKeys.has(key)) continue;

          try {
            if (this.fetchFullContent) {
              const detail = await this.fetchArticleContent(current);
              current.title = detail.title || current.title;
              current.category = detail.category || current.category;
              current.author = detail.author || current.author;
              current.publishTime = detail.publishTime || current.publishTime;
              current.content = detail.content || '';
            }

            if (!this.shouldIncludeArticle(current)) continue;

            const { fileName } = this.context.services.output.writeArticle(current);
            current.fileName = fileName;
            this._seenKeys.add(key);
            this.articles.push(current);
            this.context.services.output.writeArticlesManifest(this.articles);
            this.emit('article_saved', {
              fileName,
              article: current,
            });
            this.emit('progress', {
              totalSaved: this.articles.length,
            });
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

module.exports = CtfiotRunner;
