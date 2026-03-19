class ExampleRunner {
  constructor(context) {
    this.context = context;
    this.aborted = false;
    this.articles = [];
    this.failures = [];
  }

  emit(event, payload = {}) {
    this.context.emit(event, payload);
  }

  stop() {
    this.aborted = true;
  }

  async run() {
    try {
      this.emit('run_start', {
        imagesOnly: this.context.options.imagesOnly,
        maxPages: this.context.options.maxPages,
        concurrency: this.context.options.concurrency,
        fetchFullContent: this.context.options.fetchFullContent,
      });

      if (this.context.options.imagesOnly) {
        await this.context.services.images.localize({
          concurrency: this.context.options.concurrency,
          referer: this.context.plugin.referer,
        });
        return;
      }

      // TODO: 在这里编排你的站点抓取流程。
      // 推荐拆出：
      // - navigateToListPage()
      // - extractArticlesFromPage()
      // - fetchArticleContent(url)
      // - persistArticle(article)

      this.emit('failure', {
        title: '示例插件未实现',
        error: '请复制 src/plugins/example 并补全 runner.js 中的站点抓取逻辑。',
      });
    } catch (error) {
      this.emit('failure', {
        title: '示例插件运行出错',
        error: String(error && error.message ? error.message : error),
      });
    } finally {
      this.context.services.output.writeArticlesManifest(this.articles);
      this.emit('run_complete', {
        imagesOnly: this.context.options.imagesOnly,
        totalSaved: this.articles.length,
        failures: this.failures.length,
        aborted: this.aborted,
      });
    }
  }

  async persistArticle(article) {
    const normalizedArticle = {
      site: this.context.site,
      title: article.title || '',
      link: article.link || '',
      publishTime: article.publishTime || '',
      category: article.category || '',
      author: article.author || '',
      extractedAt: article.extractedAt || new Date().toISOString(),
      content: article.content || '',
    };

    const { fileName } = this.context.services.output.writeArticle(normalizedArticle);
    normalizedArticle.fileName = fileName;
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
}

module.exports = ExampleRunner;
