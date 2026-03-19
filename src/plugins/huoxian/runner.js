const https = require('https');
const { convertHtmlToMarkdown } = require('./markdown');

class HuoxianRunner {
  constructor(context) {
    this.context = context;
    this.baseUrl = context.plugin.baseUrl;
    this.referer = context.plugin.referer;
    this.listApiUrl = 'https://zone.huoxian.cn/api/discussions';
    this.fetchFullContent = context.options.fetchFullContent !== false;
    this.maxPages = context.options.maxPages || 1;
    this.imagesOnly = !!context.options.imagesOnly;
    this.image = !!context.options.image;
    this.concurrency = Number(context.options.concurrency) > 0 ? Number(context.options.concurrency) : 3;
    this.pageSize = 20;
    this.startDate = context.options.startDate ? new Date(context.options.startDate) : null;
    this.endDate = context.options.endDate ? new Date(context.options.endDate) : null;
    this.targetDate = context.options.targetDate ? new Date(context.options.targetDate) : (this.startDate || null);
    this.articles = [];
    this.failures = [];
    this.aborted = false;
    this._seenKeys = new Set();
  }

  get ignoredTags() {
    return new Set(['官方公告', '讨论区', '火线Zone Tips', '白帽训练营🔥']);
  }

  get metaTags() {
    return new Set(['原创文章', '精华内容']);
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

  buildListApiUrl(pageNumber) {
    const url = new URL(this.listApiUrl);
    url.searchParams.set('include', 'user,lastPostedUser,tags,tags.parent,firstPost,lastPost,firstPost');
    url.searchParams.set('sort', '');
    url.searchParams.set('page[offset]', String((pageNumber - 1) * this.pageSize));
    return url.toString();
  }

  normalizeTitle(raw) {
    return String(raw || '')
      .replace(/\s+/g, ' ')
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

  createIncludedLookup(included = []) {
    return new Map(included.map((item) => [`${item.type}:${item.id}`, item]));
  }

  getIncludedRecord(lookup, ref) {
    if (!ref || !ref.type || !ref.id) return null;
    return lookup.get(`${ref.type}:${ref.id}`) || null;
  }

  getTagNames(lookup, refs = []) {
    return refs
      .map((ref) => this.getIncludedRecord(lookup, ref))
      .filter(Boolean)
      .map((tag) => String(tag.attributes && tag.attributes.name ? tag.attributes.name : '').trim())
      .filter(Boolean)
      .filter((tag, index, tags) => tags.indexOf(tag) === index);
  }

  deriveCategory(tagNames = []) {
    const meaningfulTags = tagNames.filter((tag) => !this.metaTags.has(tag) && !this.ignoredTags.has(tag));
    if (meaningfulTags.length) return meaningfulTags.join(', ');

    return '未分类';
  }

  shouldKeepDiscussion(attributes, tagNames) {
    if (attributes && attributes.isSticky) return false;
    return !tagNames.some((tag) => this.ignoredTags.has(tag));
  }

  parseListResponse(payload) {
    const discussions = Array.isArray(payload && payload.data) ? payload.data : [];
    const lookup = this.createIncludedLookup(Array.isArray(payload && payload.included) ? payload.included : []);

    return discussions.map((discussion) => {
      const attributes = discussion.attributes || {};
      const relationships = discussion.relationships || {};
      const user = this.getIncludedRecord(lookup, relationships.user && relationships.user.data);
      const firstPost = this.getIncludedRecord(lookup, relationships.firstPost && relationships.firstPost.data);
      const tagRefs = relationships.tags && Array.isArray(relationships.tags.data) ? relationships.tags.data : [];
      const tagNames = this.getTagNames(lookup, tagRefs);

      if (!this.shouldKeepDiscussion(attributes, tagNames)) {
        return null;
      }

      const linkSlug = String(attributes.slug || discussion.id || '').trim();
      const link = linkSlug ? new URL(`/d/${linkSlug}`, this.baseUrl).toString() : '';

      return {
        site: this.context.site,
        title: this.normalizeTitle(attributes.title || ''),
        link,
        category: this.deriveCategory(tagNames),
        author: String(user && user.attributes && user.attributes.displayName ? user.attributes.displayName : '').trim(),
        publishTime: this.normalizeArticleDate(attributes.createdAt || (firstPost && firstPost.attributes && firstPost.attributes.createdAt) || ''),
        extractedAt: new Date().toISOString(),
        content: this.fetchFullContent && firstPost && firstPost.attributes
          ? convertHtmlToMarkdown(String(firstPost.attributes.contentHtml || ''))
          : '',
        sourceMeta: {
          discussionId: String(discussion.id || '').trim(),
          slug: linkSlug,
          tags: tagNames,
          viewCount: attributes.viewCount || 0,
          commentCount: attributes.commentCount || 0,
          isSticky: !!attributes.isSticky,
          thumbnail: String(attributes.customThumbnail || '').trim(),
        },
      };
    }).filter((article) => article && article.link && article.title);
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

      for (const article of pageArticles) {
        if (this.aborted) break;

        const key = this.getArticleKey(article);
        if (this._seenKeys.has(key)) continue;

        try {
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

module.exports = HuoxianRunner;
