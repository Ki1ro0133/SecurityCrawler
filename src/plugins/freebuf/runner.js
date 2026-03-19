const http = require('http');
const https = require('https');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { convertHtmlToMarkdown } = require('./markdown');

class FreebufRunner {
  constructor(context) {
    this.context = context;
    this.baseUrl = context.plugin.baseUrl;
    this.referer = context.plugin.referer;
    this.listApiUrl = 'https://www.freebuf.com/fapi/frontend/category/list';
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
    this.detailFetchDisabled = false;
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
      const client = target.protocol === 'http:' ? http : https;

      const req = client.request(target, {
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

  async fetchText(url) {
    let firstError = null;

    try {
      return await this.request(url);
    } catch (error) {
      firstError = error;
    }

    if (typeof fetch === 'function') {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': this.referer,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      if (response.ok) {
        return response.text();
      }
    }

    throw firstError || new Error(`Unable to fetch ${url}`);
  }

  async fetchJson(url) {
    const text = await this.request(url, {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
    });
    return JSON.parse(text);
  }

  buildListApiUrl(pageNumber) {
    const url = new URL(this.listApiUrl);
    url.searchParams.set('name', 'articles');
    url.searchParams.set('tag', 'category');
    url.searchParams.set('limit', '20');
    url.searchParams.set('page', String(pageNumber));
    url.searchParams.set('select', '0');
    url.searchParams.set('order', '0');
    return url.toString();
  }

  normalizeTitle(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeArticleDate(raw) {
    return String(raw || '').trim();
  }

  decodeHtml(text) {
    return String(text || '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
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

  parseListResponse(payload) {
    const items = payload && payload.data && Array.isArray(payload.data.data_list)
      ? payload.data.data_list
      : [];

    return items.map((item) => ({
      site: this.context.site,
      title: this.normalizeTitle(item.post_title || ''),
      link: item.url ? new URL(item.url, this.referer).toString() : '',
      category: String(item.category || '').trim(),
      author: String(item.nickname || item.username || '').trim(),
      publishTime: this.normalizeArticleDate(item.post_date || ''),
      extractedAt: new Date().toISOString(),
      sourceMeta: {
        articleId: String(item.ID || '').trim(),
        excerpt: this.decodeHtml(item.content || ''),
        coverImage: String(item.post_image || item.column_post_picture || '').trim(),
      },
    })).filter((article) => article.link && article.title);
  }

  extractNuxtData(html) {
    const match = String(html || '').match(/window\.__NUXT__=([\s\S]*?)<\/script>/i);
    if (!match) {
      throw new Error('未找到 window.__NUXT__ 数据');
    }

    const expression = match[1].trim().replace(/;$/, '');
    return vm.runInNewContext(`(${expression})`, {}, { timeout: 1000 });
  }

  resolveFallbackContentHtml(html) {
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const title = this.normalizeTitle(document.querySelector('.page-header .title')?.textContent || '');
    const tags = Array.from(document.querySelectorAll('.tags-panel .txt'))
      .map((node) => String(node.textContent || '').replace(/^#\s*/, '').trim())
      .filter(Boolean);

    return {
      title,
      tags,
      contentHtml: '',
    };
  }

  async fetchArticleContent(article) {
    const html = await this.fetchText(article.link);
    const nuxt = this.extractNuxtData(html);
    const serverData = nuxt && Array.isArray(nuxt.data) ? nuxt.data[0] && nuxt.data[0].serverData : null;

    if (!serverData) {
      throw new Error('未找到文章详情数据');
    }

    const fallback = this.resolveFallbackContentHtml(html);
    const category = Array.isArray(serverData.category)
      ? serverData.category.map((item) => String(item && item.name ? item.name : '').trim()).filter(Boolean).join(', ')
      : article.category || '';
    const tags = Array.isArray(serverData.tag)
      ? serverData.tag.map((item) => String(item && item.name ? item.name : '').trim()).filter(Boolean)
      : fallback.tags;
    const contentHtml = String(serverData.post_content || '').trim();

    if (!contentHtml) {
      throw new Error('未找到文章正文 HTML');
    }

    return {
      title: this.normalizeTitle(serverData.post_title || fallback.title || article.title || ''),
      category,
      author: String(serverData.nickname || article.author || '').trim(),
      publishTime: this.normalizeArticleDate(serverData.post_date || article.publishTime || ''),
      content: convertHtmlToMarkdown(contentHtml),
      sourceMeta: {
        description: this.decodeHtml(serverData.post_desc || ''),
        tags,
      },
    };
  }

  buildFallbackContent(article) {
    const excerpt = String(article && article.sourceMeta && article.sourceMeta.excerpt ? article.sourceMeta.excerpt : '').trim();
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
    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber++) {
      if (this.aborted) break;

      const payload = await this.fetchJson(this.buildListApiUrl(pageNumber));
      const pageArticles = this.parseListResponse(payload);
      if (!pageArticles.length) break;

      let index = 0;
      const workers = Array.from({ length: Math.max(1, this.concurrency) }, async () => {
        while (index < pageArticles.length && !this.aborted) {
          const current = pageArticles[index++];
          const key = this.getArticleKey(current);
          if (this._seenKeys.has(key)) continue;

          try {
            if (this.fetchFullContent && !this.detailFetchDisabled) {
              try {
                const detail = await this.fetchArticleContent(current);
                current.title = detail.title || current.title;
                current.category = detail.category || current.category;
                current.author = detail.author || current.author;
                current.publishTime = detail.publishTime || current.publishTime;
                current.content = detail.content || '';
                current.sourceMeta = {
                  ...(current.sourceMeta || {}),
                  ...(detail.sourceMeta || {}),
                };
              } catch (error) {
                const message = String(error && error.message ? error.message : error);
                if (/HTTP (405|502)\b/.test(message)) {
                  this.detailFetchDisabled = true;
                }
                current.content = this.buildFallbackContent(current);
                current.sourceMeta = {
                  ...(current.sourceMeta || {}),
                  detailFetchError: message,
                };
              }
            } else if (this.fetchFullContent) {
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

module.exports = FreebufRunner;
