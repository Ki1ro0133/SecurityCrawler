const https = require('https');
const { JSDOM } = require('jsdom');
const { convertHtmlToMarkdown } = require('./markdown');

class SeebugRunner {
  constructor(context) {
    this.context = context;
    this.baseUrl = context.plugin.baseUrl;
    this.referer = context.plugin.referer;
    this.rssUrl = 'https://paper.seebug.org/rss/';
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
    this.browser = null;
    this.browserContext = null;
    this._onSigint = null;
    this._onSigterm = null;
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

  async fetchText(url) {
    return this.request(url, {
      'Accept': 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
    });
  }

  normalizeTitle(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeText(raw) {
    return String(raw || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  normalizeInlineText(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  sanitizeExtractedContent(raw) {
    return String(raw || '')
      .replace(/^.*Report issue for preceding element.*$/gm, (line) => line.replace(/Report issue for preceding element.*$/g, '').trim())
      .replace(/\bReport issue for preceding element\b/g, '')
      .replace(/([^\n])Abstract(?=[A-Z])/g, '$1Abstract\n\n')
      .replace(/([^\n])([IVX]+(?:-[A-Z])?\s+[A-Z][^\n]*)/g, '$1$2')
      .replace(/^\s*$/gm, '')
      .replace(/^[ \t]*[∙•·]\s*\\bullet\s*/gm, '- ')
      .replace(/[∙•·]\s*\\bullet\s*/g, '- ')
      .replace(/^[ \t]*[•∙·]\s*$/gm, '')
      .replace(/^[ \t]*[•∙·][ \t]+/gm, '- ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  normalizeArticleDate(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return text;

    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    return formatter.format(parsed).replace(' ', ' ');
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

  getInjectedCookieSource() {
    const optionValue = String(this.context && this.context.options && this.context.options.seebugCookies ? this.context.options.seebugCookies : '').trim();
    if (optionValue) return optionValue;

    return (
      process.env.SEEBUG_PLAYWRIGHT_COOKIES_JSON
      || process.env.SEEBUG_COOKIES_JSON
      || process.env.SEEBUG_COOKIE_HEADER
      || process.env.SEEBUG_COOKIES
      || ''
    ).trim();
  }

  hasInjectedCookies() {
    return !!this.getInjectedCookieSource();
  }

  toPlaywrightCookie(cookie, fallbackDomain = '.paper.seebug.org') {
    if (!cookie || typeof cookie !== 'object') return null;
    const name = String(cookie.name || '').trim();
    const value = String(cookie.value || '').trim();
    if (!name) return null;

    const normalized = {
      name,
      value,
      domain: String(cookie.domain || fallbackDomain).trim() || fallbackDomain,
      path: String(cookie.path || '/').trim() || '/',
      httpOnly: !!cookie.httpOnly,
      secure: cookie.secure !== false,
      sameSite: ['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? cookie.sameSite : 'None',
    };

    if (cookie.expires !== undefined && cookie.expires !== null && cookie.expires !== '') {
      const parsedExpires = Number(cookie.expires);
      if (Number.isFinite(parsedExpires)) {
        normalized.expires = parsedExpires;
      }
    }

    return normalized;
  }

  parseInjectedCookies() {
    const source = this.getInjectedCookieSource();
    if (!source) return [];

    if (source.startsWith('{') || source.startsWith('[')) {
      const parsed = JSON.parse(source);
      const cookies = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed && parsed.cookies)
          ? parsed.cookies
          : [];

      return cookies
        .map((cookie) => this.toPlaywrightCookie(cookie))
        .filter(Boolean);
    }

    return source
      .split(';')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => {
        const eqIndex = segment.indexOf('=');
        if (eqIndex <= 0) return null;
        const name = segment.slice(0, eqIndex).trim();
        const value = segment.slice(eqIndex + 1).trim();
        return this.toPlaywrightCookie({ name, value });
      })
      .filter(Boolean);
  }

  extractOriginalLinkFromContent(content) {
    const match = String(content || '').match(/^(?:原文链接|Original Link)\s*[:：]\s*(https?:\/\/\S+)/im);
    return match ? match[1].trim() : '';
  }

  resolveBestSourceLink(article) {
    const originalLink = String(article && article.sourceMeta && article.sourceMeta.originalLink ? article.sourceMeta.originalLink : '').trim();
    if (originalLink) return originalLink;
    return String(article && article.link ? article.link : '').trim();
  }

  splitDescriptionLines(rawDescription) {
    return this.normalizeText(rawDescription)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  parseDescription(rawDescription) {
    const lines = this.splitDescriptionLines(rawDescription);
    let author = '';
    let translator = '';
    let originalLink = '';
    const body = [];
    let seenSummaryHeading = false;

    for (const line of lines) {
      if (!author && /^(作者|Author)\s*[:：]\s*/i.test(line)) {
        author = line.replace(/^(作者|Author)\s*[:：]\s*/i, '').trim();
        continue;
      }
      if (!translator && /^(译者|Translator)\s*[:：]\s*/i.test(line)) {
        translator = line.replace(/^(译者|Translator)\s*[:：]\s*/i, '').trim();
        continue;
      }
      if (!originalLink && /^(原文链接|Original Link)\s*[:：]\s*/i.test(line)) {
        originalLink = line.replace(/^(原文链接|Original Link)\s*[:：]\s*/i, '').trim();
        continue;
      }
      if (/^(摘要|Abstract)\s*[:：]?$/i.test(line)) {
        seenSummaryHeading = true;
        body.push('## 摘要');
        continue;
      }

      body.push(line);
    }

    const content = this.sanitizeExtractedContent(convertHtmlToMarkdown(body.join('\n\n')));
    return {
      author,
      translator,
      originalLink,
      content: seenSummaryHeading ? content : (content ? `## 摘要\n\n${content}` : ''),
    };
  }

  resolveDetailBody(document) {
    const selectors = [
      '.article-content',
      '.article-detail',
      '.paper-content',
      '.detail-content',
      '.post-content',
      '.entry-content',
      '.markdown-body',
      '.content-body',
      'article .content',
      'article',
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;

      const clone = node.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, iframe, .article-meta, .meta, .share, .recommend, .related').forEach((element) => element.remove());
      const textLength = this.normalizeInlineText(clone.textContent || '').length;
      if (textLength >= 120) {
        return clone;
      }
    }

    return null;
  }

  parseDetailPage(html, article) {
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const title = this.normalizeTitle(
      document.querySelector('h1')?.textContent
      || document.querySelector('.article-title')?.textContent
      || document.title
      || article.title
    );
    const bodyNode = this.resolveDetailBody(document);
    const content = bodyNode ? this.sanitizeExtractedContent(convertHtmlToMarkdown(bodyNode.innerHTML || '')) : '';
    const category = this.normalizeInlineText(
      document.querySelector('.category')?.textContent
      || document.querySelector('.tag')?.textContent
      || article.category
    );
    const author = this.normalizeInlineText(
      document.querySelector('[rel="author"]')?.textContent
      || document.querySelector('.author')?.textContent
      || article.author
    );
    const publishTime = this.normalizeArticleDate(
      document.querySelector('time')?.getAttribute('datetime')
      || document.querySelector('time')?.textContent
      || article.publishTime
    );

    return {
      title,
      category,
      author,
      publishTime,
      content,
    };
  }

  async initBrowserIfNeeded() {
    if (!this.hasInjectedCookies() || this.browserContext) return;

    const { chromium } = require('playwright');
    this.browser = await chromium.launch({ headless: true });
    this.browserContext = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 1200 },
    });

    const cookies = this.parseInjectedCookies();
    if (cookies.length) {
      await this.browserContext.addCookies(cookies);
    }
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
    }
    this.browser = null;
    this.browserContext = null;
  }

  setupSignalHandlers() {
    if (this._onSigint || this._onSigterm) return;

    this._onSigint = () => {
      if (!this.aborted) this.aborted = true;
    };
    this._onSigterm = () => {
      if (!this.aborted) this.aborted = true;
    };

    process.on('SIGINT', this._onSigint);
    process.on('SIGTERM', this._onSigterm);
  }

  teardownSignalHandlers() {
    if (this._onSigint) {
      process.off('SIGINT', this._onSigint);
      this._onSigint = null;
    }
    if (this._onSigterm) {
      process.off('SIGTERM', this._onSigterm);
      this._onSigterm = null;
    }
  }

  async fetchArticleContent(article) {
    if (!this.browserContext) {
      throw new Error('未初始化 Playwright 上下文');
    }

    const page = await this.browserContext.newPage();

    try {
      const targetUrl = this.resolveBestSourceLink(article);
      if (!targetUrl) {
        throw new Error('缺少可访问的文章链接');
      }

      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) {
          route.abort();
          return;
        }
        route.continue();
      });

      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
        referer: this.referer,
      });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1200);

      const html = await page.content();
      if (/知道创宇云防御-浏览器安全检查/.test(html)) {
        throw new Error('注入 cookies 后仍命中云防御检查页');
      }

      const detail = this.parseDetailPage(html, article);
      if (!detail.content || detail.content.length < 120) {
        throw new Error('未提取到可靠的正文内容');
      }

      return detail;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fetchArticleContentWithRetry(article, retries = 0, baseDelay = 1200) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= retries && !this.aborted) {
      try {
        return await this.fetchArticleContent(article);
      } catch (error) {
        lastError = error;
        if (attempt === retries) break;
        await this.sleep(baseDelay * Math.pow(2, attempt));
        attempt += 1;
      }
    }

    throw lastError || new Error('抓取 Seebug 详情失败');
  }

  parseRssFeed(xmlText) {
    const dom = new JSDOM(xmlText, { contentType: 'text/xml' });
    const { document } = dom.window;
    const items = Array.from(document.querySelectorAll('channel > item'));

    return items.map((item) => {
      const rawDescription = item.querySelector('description')?.textContent || '';
      const parsedDescription = this.parseDescription(rawDescription);
      const link = String(item.querySelector('link')?.textContent || '').trim();

      return {
        site: this.context.site,
        title: this.normalizeTitle(item.querySelector('title')?.textContent || ''),
        link,
        category: this.normalizeText(item.querySelector('category')?.textContent || ''),
        author: parsedDescription.author,
        publishTime: this.normalizeArticleDate(item.querySelector('pubDate')?.textContent || ''),
        extractedAt: new Date().toISOString(),
        content: this.fetchFullContent ? parsedDescription.content : '',
        sourceMeta: {
          originalLink: parsedDescription.originalLink,
          translator: parsedDescription.translator,
          rssSummaryOnly: true,
          description: this.normalizeText(rawDescription),
          guid: this.normalizeText(item.querySelector('guid')?.textContent || ''),
        },
      };
    }).filter((article) => article.link && article.title);
  }

  buildFallbackContent(article) {
    const description = this.normalizeText(article && article.sourceMeta && article.sourceMeta.description ? article.sourceMeta.description : '');
    if (!description) return '';
    return this.sanitizeExtractedContent(`## 摘要\n\n${description}\n`);
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
      content: this.sanitizeExtractedContent(article.content || ''),
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
    const rss = await this.fetchText(this.rssUrl);
    const articles = this.parseRssFeed(rss);

    let index = 0;
    const workers = Array.from({ length: Math.max(1, this.concurrency) }, async () => {
      while (index < articles.length && !this.aborted) {
        const article = articles[index];
        index += 1;

        const key = this.getArticleKey(article);
        if (this._seenKeys.has(key)) continue;

        try {
          if (this.fetchFullContent && this.browserContext) {
            try {
              const detail = await this.fetchArticleContentWithRetry(article, 0);
              article.title = detail.title || article.title;
              article.category = detail.category || article.category;
              article.author = detail.author || article.author;
              article.publishTime = detail.publishTime || article.publishTime;
              article.content = detail.content || article.content;
            } catch (error) {
              article.sourceMeta = {
                ...(article.sourceMeta || {}),
                detailFetchError: String(error && error.message ? error.message : error),
              };
            }
          }

          if (!article.content) {
            article.content = this.buildFallbackContent(article);
          }

          if (!this.shouldIncludeArticle(article)) continue;
          await this.persistArticle(article, key);
        } catch (error) {
          const failure = {
            link: article.link,
            title: article.title || '未知标题',
            error: String(error && error.message ? error.message : error),
          };
          this.failures.push(failure);
          this.emit('failure', failure);
        }
      }
    });

    await Promise.all(workers);
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

      this.setupSignalHandlers();
      await this.initBrowserIfNeeded();
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
      await this.closeBrowser();
      this.teardownSignalHandlers();
      this.emit('run_complete', {
        imagesOnly: this.imagesOnly,
        totalSaved: this.articles.length,
        failures: this.failures.length,
        aborted: this.aborted,
      });
    }
  }
}

module.exports = SeebugRunner;
