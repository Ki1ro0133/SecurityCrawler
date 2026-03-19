const https = require('https');
const { convertHtmlToMarkdown } = require('./markdown');

class AnquankeRunner {
  constructor(context) {
    this.context = context;
    this.baseUrl = context.plugin.baseUrl;
    this.referer = context.plugin.referer;
    this.listApiUrl = 'https://api.anquanke.com/data/v1/posts';
    this.detailApiUrl = 'https://api.anquanke.com/data/v1/post';
    this.listPageSize = 100;
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
    this._seenListUrls = new Set();
  }

  emit(event, payload = {}) {
    this.context.emit(event, payload);
  }

  stop() {
    this.aborted = true;
  }

  request(url, headers = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);

      const req = https.request(target, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': this.referer,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
      }, (res) => {
        const statusCode = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          if (redirectCount >= 5) {
            reject(new Error(`Too many redirects while fetching ${url}`));
            res.resume();
            return;
          }

          const nextUrl = new URL(res.headers.location, target).toString();
          res.resume();
          this.request(nextUrl, headers, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode} while fetching ${url}`));
            return;
          }
          resolve(body);
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  async fetchJson(url) {
    const text = await this.request(url, {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
    });
    return JSON.parse(text);
  }

  buildInitialListApiUrl() {
    const url = new URL(this.listApiUrl);
    url.searchParams.set('page', '0');
    url.searchParams.set('size', String(this.listPageSize));
    url.searchParams.set('category', 'knowledge');
    return url.toString();
  }

  buildDetailApiUrl(articleId) {
    const url = new URL(this.detailApiUrl);
    url.searchParams.set('id', String(articleId || '').trim());
    return url.toString();
  }

  buildArticleLink(articleId) {
    return new URL(`/post/id/${articleId}`, this.baseUrl).toString();
  }

  normalizeTitle(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeArticleDate(raw) {
    return String(raw || '').trim();
  }

  normalizeTags(rawTags) {
    if (!Array.isArray(rawTags)) return [];

    return rawTags
      .map((tag) => {
        if (typeof tag === 'string') return tag.trim();
        if (tag && typeof tag === 'object') {
          return String(tag.name || tag.title || tag.label || '').trim();
        }
        return '';
      })
      .filter(Boolean)
      .filter((tag, index, tags) => tags.indexOf(tag) === index);
  }

  deriveCategory(tags, fallbackCategory) {
    if (Array.isArray(tags) && tags.length) {
      return tags.join(', ');
    }
    return String(fallbackCategory || '').trim();
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

  assertSuccess(payload, url) {
    if (payload && payload.success === false) {
      throw new Error(`API returned success=false for ${url}`);
    }
  }

  parseListResponse(payload) {
    const items = Array.isArray(payload && payload.data) ? payload.data : [];

    return items.map((item) => {
      const articleId = String(item && item.id ? item.id : '').trim();
      const tags = this.normalizeTags(item && item.tags);
      const link = articleId ? this.buildArticleLink(articleId) : '';

      return {
        site: this.context.site,
        title: this.normalizeTitle(item && item.title ? item.title : ''),
        link,
        category: this.deriveCategory(tags, item && item.category_name),
        author: String(item && item.author && item.author.nickname ? item.author.nickname : '').trim(),
        publishTime: this.normalizeArticleDate(item && item.date ? item.date : ''),
        extractedAt: new Date().toISOString(),
        sourceMeta: {
          articleId,
          articleType: String(item && item.type ? item.type : '').trim(),
          categoryName: String(item && item.category_name ? item.category_name : '').trim(),
          categorySlug: String(item && item.category_slug ? item.category_slug : '').trim(),
          description: String(item && item.desc ? item.desc : '').trim(),
          coverImage: String(item && item.cover ? item.cover : '').trim(),
          pv: Number(item && item.pv ? item.pv : 0) || 0,
          tags,
        },
      };
    }).filter((article) => article.link && article.title && article.sourceMeta.articleId);
  }

  resolveNextListUrl(currentUrl, payload) {
    const next = payload && payload.next ? String(payload.next).trim() : '';
    if (!next) return null;
    return new URL(next, currentUrl).toString();
  }

  buildFallbackContent(article) {
    const description = String(article && article.sourceMeta && article.sourceMeta.description ? article.sourceMeta.description : '').trim();
    if (!description) return '';
    return `## 摘要\n\n${description}\n`;
  }

  async fetchArticleContent(article) {
    const articleId = article && article.sourceMeta ? article.sourceMeta.articleId : '';
    if (!articleId) {
      throw new Error('缺少文章 ID');
    }

    const detailUrl = this.buildDetailApiUrl(articleId);
    const detail = await this.fetchJson(detailUrl);
    this.assertSuccess(detail, detailUrl);

    const tags = this.normalizeTags(detail.tags);
    const contentHtml = String(detail.content || '').trim();

    return {
      title: this.normalizeTitle(detail.title || article.title || ''),
      category: this.deriveCategory(tags, detail.category_name || article.category),
      author: String(detail.author && detail.author.nickname ? detail.author.nickname : article.author || '').trim(),
      publishTime: this.normalizeArticleDate(detail.date || article.publishTime || ''),
      content: contentHtml ? convertHtmlToMarkdown(contentHtml) : '',
      sourceMeta: {
        articleType: String(detail.type || '').trim(),
        categoryName: String(detail.category_name || '').trim(),
        categorySlug: String(detail.category_slug || '').trim(),
        description: String(detail.desc || '').trim(),
        coverImage: String(detail.cover || '').trim(),
        pv: Number(detail.pv || 0) || 0,
        tags,
      },
    };
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

  async scrapePageArticles(pageArticles) {
    let index = 0;
    const workers = Array.from({ length: Math.max(1, this.concurrency) }, async () => {
      while (index < pageArticles.length && !this.aborted) {
        const current = pageArticles[index++];
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

  async scrapeArticles() {
    let currentListUrl = this.buildInitialListApiUrl();
    let pageCount = 0;

    while (currentListUrl && pageCount < this.maxPages && !this.aborted) {
      if (this._seenListUrls.has(currentListUrl)) break;
      this._seenListUrls.add(currentListUrl);

      const payload = await this.fetchJson(currentListUrl);
      this.assertSuccess(payload, currentListUrl);

      const pageArticles = this.parseListResponse(payload);
      if (!pageArticles.length) break;

      await this.scrapePageArticles(pageArticles);

      pageCount += 1;
      currentListUrl = this.resolveNextListUrl(currentListUrl, payload);
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

module.exports = AnquankeRunner;
