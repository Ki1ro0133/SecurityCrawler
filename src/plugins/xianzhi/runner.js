class XianzhiRunner {
  constructor(context) {
    this.context = context;
    this.baseUrl = context.plugin.baseUrl;
    this.referer = context.plugin.referer;
    this.startDate = context.options.startDate ? new Date(context.options.startDate) : null;
    this.endDate = context.options.endDate ? new Date(context.options.endDate) : null;
    this.targetDate = context.options.targetDate ? new Date(context.options.targetDate) : (this.startDate || null);
    this.fetchFullContent = context.options.fetchFullContent !== false;
    this.maxPages = context.options.maxPages || 1;
    this.imagesOnly = !!context.options.imagesOnly;
    this.image = !!context.options.image;
    this.concurrency = Number(context.options.concurrency) > 0 ? Number(context.options.concurrency) : 3;
    this.articles = [];
    this.failures = [];
    this.browser = null;
    this.page = null;
    this.aborted = false;
    this._onSigint = null;
    this._onSigterm = null;
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

  async init() {
    const { chromium } = require('playwright');
    this.browser = await chromium.launch({ headless: true });
    const browserContext = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await browserContext.newPage();
  }

  async navigateToNews() {
    try {
      await this.page.goto(this.baseUrl, {
        referer: this.referer,
        waitUntil: 'domcontentloaded',
      });

      try {
        const communityTab = this.page.locator('text=社区板块').first();
        if (await communityTab.isVisible({ timeout: 5000 })) {
          await communityTab.click();
          await this.page.waitForLoadState('load');
        }
      } catch (_) {}
    } catch (error) {
      throw new Error(`导航到新闻页面失败: ${error.message}`);
    }
  }

  shouldIncludeArticle(article) {
    if (!article.publishTime) return false;

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
      return false;
    }
  }

  getArticleKey(article) {
    return (article.link && article.link.trim()) || `${(article.title || '').trim()}|${article.publishTime || ''}`;
  }

  async scrapeArticles() {
    let hasMorePages = true;
    let currentPage = 1;

    while (hasMorePages && currentPage <= this.maxPages) {
      if (this.aborted) break;

      const articlesOnPage = await this.extractArticlesFromPage();
      if (articlesOnPage.length === 0) break;

      const filteredArticles = articlesOnPage.filter((article) => this.shouldIncludeArticle(article));

      if (this.fetchFullContent) {
        let index = 0;
        const worker = async () => {
          while (index < filteredArticles.length && !this.aborted) {
            const current = filteredArticles[index++];
            const key = this.getArticleKey(current);
            if (this._seenKeys.has(key)) continue;

            try {
              const articleData = await this.fetchArticleContentWithRetry(current.link, 1);
              current.content = articleData.content;
              if (articleData.title && articleData.title !== '未知标题' && articleData.title !== '访问失败') {
                current.title = articleData.title;
              }
              await this.persistArticle(current, key);
            } catch (error) {
              if (this.aborted) break;
              this.failures.push({
                link: current.link,
                title: (current.title || '').trim() || '未知标题',
                error: String(error && error.message ? error.message : error),
              });
              this.emit('failure', {
                link: current.link,
                title: (current.title || '').trim() || '未知标题',
                error: String(error && error.message ? error.message : error),
              });
            }
          }
        };

        await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, () => worker()));
      } else {
        for (const article of filteredArticles) {
          if (this.aborted) break;
          const key = this.getArticleKey(article);
          if (this._seenKeys.has(key)) continue;
          await this.persistArticle(article, key);
        }
      }

      const thresholdDate = this.startDate || this.targetDate || null;
      const hasOlderArticles = thresholdDate
        ? articlesOnPage.some((article) => {
          if (!article.publishTime) return false;
          try {
            return new Date(article.publishTime) <= thresholdDate;
          } catch (_) {
            return false;
          }
        })
        : false;

      if (hasOlderArticles && currentPage > 3) break;
      if (this.aborted) break;

      hasMorePages = await this.goToNextPage();
      if (hasMorePages) currentPage++;
    }
  }

  async persistArticle(article, key) {
    const { fileName } = this.context.services.output.writeArticle(article);
    if (this._seenKeys.has(key)) return;

    article.fileName = fileName;
    this._seenKeys.add(key);
    this.articles.push(article);
    this.context.services.output.writeArticlesManifest(this.articles);
    this.emit('article_saved', { fileName, article });
    this.emit('progress', { totalSaved: this.articles.length });
  }

  async fetchArticleContent(articleUrl) {
    try {
      if (this.aborted) throw new Error('aborted');

      const articlePage = await this.browser.newPage();

      try {
        await articlePage.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (['image', 'media'].includes(type)) {
            route.abort();
            return;
          }
          route.continue();
        });
      } catch (_) {}

      if (this.aborted) {
        try { await articlePage.close(); } catch (_) {}
        throw new Error('aborted');
      }

      await articlePage.goto(articleUrl, {
        waitUntil: 'load',
        timeout: 300000,
        referer: this.referer,
      });

      try { await articlePage.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch (_) {}
      try { await articlePage.waitForSelector('.ne-viewer-body', { timeout: 15000 }); } catch (_) {}

      try {
        await articlePage.evaluate(async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          for (let i = 0; i < 10; i++) {
            window.scrollBy(0, Math.max(200, window.innerHeight * 0.8));
            await sleep(100);
          }
          window.scrollTo(0, document.body.scrollHeight);
          await sleep(150);
        });
      } catch (_) {}

      try {
        await articlePage.waitForFunction(() => {
          const el = document.querySelector('.ne-viewer-body');
          if (!el) return false;
          const len = (el.innerText || '').replace(/\s+/g, '').length;
          const state = (window.__mdStabilize ||= { last: 0, stable: 0 });
          if (len === state.last) state.stable++; else { state.last = len; state.stable = 0; }
          return state.stable >= 2;
        }, { timeout: 4000 });
      } catch (_) {}

      let title = '';
      try {
        const titleSelectors = ['h1', '.article-title', '.entry-title', '[class*="title"]:first-child', 'title'];
        for (const selector of titleSelectors) {
          const titleElement = articlePage.locator(selector).first();
          if (await titleElement.isVisible({ timeout: 2000 })) {
            const titleText = await titleElement.textContent();
            const trimmed = titleText ? titleText.trim() : '';
            if (trimmed && trimmed.length > 5) {
              title = trimmed;
              break;
            }
          }
        }

        if (!title) {
          const pageTitle = await articlePage.title();
          if (pageTitle && pageTitle.includes('-先知社区')) {
            title = pageTitle.replace('-先知社区', '').trim();
          }
        }
      } catch (_) {}

      let content = '';
      try {
        const { convertHtmlToMarkdown } = require('./markdown');
        const contentElement = articlePage.locator('.ne-viewer-body').first();

        try {
          await articlePage.waitForSelector('.cm-content', { timeout: 2000 });
          await articlePage.evaluate(async () => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            document.querySelectorAll('.ne-codeblock-height-limit').forEach((el) => {
              el.classList.remove('ne-codeblock-height-limit');
            });
            const scrollers = Array.from(document.querySelectorAll('.cm-scroller'));
            scrollers.forEach((el) => { el.style.maxHeight = 'none'; });
            document.querySelectorAll('.ne-card[data-card-name="codeblock"]').forEach((el) => el.scrollIntoView({ block: 'center' }));
            const countLines = () => document.querySelectorAll('.cm-content .cm-line').length;
            let prev = countLines();
            for (let i = 0; i < 10; i++) {
              scrollers.forEach((el) => { el.scrollTop = el.scrollHeight; });
              await sleep(160);
              const curr = countLines();
              if (curr <= prev) break;
              prev = curr;
            }

            const blocks = Array.from(document.querySelectorAll('.ne-card[data-card-name="codeblock"]'));
            const normalizeLang = (lang) => {
              const normalized = (lang || '').toLowerCase();
              if (normalized === 'shell') return 'bash';
              if (['plain', 'plaintext', 'text'].includes(normalized)) return '';
              return normalized;
            };
            const getLineText = (node) => {
              let out = '';
              const walk = (current) => {
                if (!current) return;
                if (current.nodeType === 3) {
                  out += current.textContent || '';
                } else if (current.nodeType === 1) {
                  if (current.tagName && current.tagName.toLowerCase() === 'br') return;
                  for (const child of current.childNodes) walk(child);
                }
              };
              walk(node);
              return out.replace(/\u200B/g, '');
            };

            blocks.forEach((block) => {
              const modeEl = block.querySelector('[data-codeblock-mode]') || block.querySelector('.cm-content');
              const lang = normalizeLang(modeEl ? (modeEl.getAttribute('data-codeblock-mode') || modeEl.getAttribute('data-language') || '') : '');
              const lineEls = block.querySelectorAll('.cm-line');
              let lines = [];

              if (lineEls.length) {
                lines = Array.from(lineEls).map((lineEl) => getLineText(lineEl));
              } else {
                const cmContent = block.querySelector('.cm-content');
                if (cmContent) {
                  for (const child of cmContent.childNodes) {
                    lines.push(getLineText(child));
                  }
                } else {
                  const inner = block.querySelector('.ne-codeblock-inner') || block;
                  lines = (inner.textContent || '').replace(/\u200B/g, '').split(/\r?\n/);
                }
              }

              const pre = document.createElement('pre');
              const code = document.createElement('code');
              if (lang) code.setAttribute('data-language', lang);
              code.textContent = lines.join('\n').replace(/\r\n?/g, '\n');
              pre.appendChild(code);
              block.innerHTML = '';
              block.appendChild(pre);
            });
          });
          await this.sleep(100);
        } catch (_) {}

        const htmlContent = await contentElement.innerHTML();
        if (htmlContent && htmlContent.length > 100) {
          content = convertHtmlToMarkdown(htmlContent);
        }
        if (!content) content = '无法获取文章内容';
      } catch (error) {
        content = `提取文章内容失败: ${error.message}`;
      }

      await articlePage.close();

      return {
        title: title.trim() || '未知标题',
        content: content.trim() || '无法获取文章内容',
      };
    } catch (error) {
      return {
        title: '访问失败',
        content: this.aborted ? '已中断' : `访问文章页面失败: ${error.message}`,
      };
    }
  }

  async fetchArticleContentWithRetry(articleUrl, retries = 1, baseDelay = 800) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= retries && !this.aborted) {
      try {
        const result = await this.fetchArticleContent(articleUrl);
        if (!result || result.title === '访问失败' || !result.content || /无法获取文章内容|提取文章内容失败/i.test(result.content)) {
          throw new Error(result && result.title ? result.title : '抓取失败');
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt === retries) break;
        await this.sleep(baseDelay * Math.pow(2, attempt));
        attempt++;
      }
    }

    throw lastError || new Error('抓取失败');
  }

  async extractArticlesFromPage() {
    if (this.aborted) return [];

    await this.page.waitForSelector('li[data-cateid="26"].selected', { timeout: 10000 });
    await this.page.waitForSelector('#news_list .news_item', { timeout: 10000 });

    const selectors = ['.news_item', 'div[class*="news_item"]'];
    const articles = [];

    for (const selector of selectors) {
      try {
        const elements = await this.page.locator(selector).all();
        if (!elements.length) continue;

        for (const element of elements) {
          try {
            const article = await this.extractArticleInfo(element);
            if (article && article.title) articles.push(article);
          } catch (_) {}
        }

        if (articles.length) break;
      } catch (_) {}
    }

    return articles;
  }

  async extractArticleInfo(element) {
    try {
      let title = '';
      let link = '';
      let publishTime = '';
      let category = '';
      let author = '';

      try {
        const newsLinks = await element.locator('a[href*="/news/"]').all();
        if (newsLinks.length >= 2) {
          title = ((await newsLinks[1].textContent()) || '').trim();
          const href = await newsLinks[1].getAttribute('href');
          link = href ? (href.startsWith('http') ? href : new URL(href, this.baseUrl).href) : '';
        } else if (newsLinks.length >= 1) {
          title = ((await newsLinks[0].textContent()) || '').trim();
          const href = await newsLinks[0].getAttribute('href');
          link = href ? (href.startsWith('http') ? href : new URL(href, this.baseUrl).href) : '';
        }
      } catch (_) {}

      try {
        const fullText = await element.textContent();
        const match = fullText.match(/·\s*\d+浏览\s*·\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/)
          || fullText.match(/(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
        publishTime = match ? match[1].trim() : '';
      } catch (_) {}

      try {
        const categoryLink = element.locator('a[href*="cate_id="]').first();
        if (await categoryLink.isVisible({ timeout: 1000 })) {
          category = ((await categoryLink.textContent()) || '').trim();
        }
      } catch (_) {}

      try {
        const authorLink = element.locator('a[href*="/users/"]').first();
        if (await authorLink.isVisible({ timeout: 1000 })) {
          const authorText = await authorLink.textContent();
          const lines = (authorText || '').split('\n').filter((line) => line.trim());
          author = lines[0] ? lines[0].trim() : '';
        }
      } catch (_) {}

      if (title && title.length > 5) {
        return {
          site: this.context.site,
          title,
          link,
          publishTime,
          category,
          author,
          extractedAt: new Date().toISOString(),
        };
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  async goToNextPage() {
    try {
      if (this.aborted) return false;

      const nextPageLink = this.page.locator('a:has-text("下一页")').first();
      if (!(await nextPageLink.isVisible({ timeout: 3000 }))) return false;

      const prevFirstHref = await this.page.evaluate(() => {
        const el = document.querySelector('#news_list .news_item a[href*="/news/"]');
        return el ? el.getAttribute('href') : null;
      });

      await nextPageLink.click();

      try {
        await this.page.waitForFunction((prev) => {
          const el = document.querySelector('#news_list .news_item a[href*="/news/"]');
          const href = el ? el.getAttribute('href') : null;
          return href && href !== prev;
        }, prevFirstHref, { timeout: 8000 });
      } catch (_) {
        const href = await nextPageLink.getAttribute('href');
        if (href && !/^javascript|^#/.test(href)) {
          const absolute = new URL(href, this.baseUrl).href;
          await this.page.goto(absolute, { waitUntil: 'domcontentloaded' });
          await this.page.waitForLoadState('networkidle');
        } else {
          await this.page.waitForLoadState('networkidle');
          await this.page.waitForTimeout(1500);
        }
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  async saveResults() {
    if (!this.articles.length) return;
    this.context.services.output.writeArticlesManifest(this.articles);
    this.context.services.output.writeFinalSummaryAndFailures(this.articles, this.failures || []);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
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
      await this.init();
      await this.navigateToNews();
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
      if (!this.imagesOnly) {
        await this.close();
      }
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

module.exports = XianzhiRunner;
