const path = require('path');
const {
  getAllowedRunOptionKeys,
  getPluginCustomFieldKeys,
  loadAppConfig,
  pickRunOptionKeys,
} = require('./config');
const { discoverPlugins } = require('./plugin-manager');
const {
  deleteArticleFile,
  ensureSiteDirs,
  getSiteOutputDir,
  listArticlesFromDisk,
  listRecoveredArticles,
} = require('./storage');
const { localizeImagesInOutput } = require('./image-localizer');
const {
  writeArticlesManifest,
  writeArticleMarkdown,
  writeFinalSummaryAndFailures,
} = require('../utils/files');

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRunOptions(input = {}, customFieldKeys = []) {
  const normalized = {
    site: input.site,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    targetDate: input.targetDate || null,
    maxPages: toPositiveNumber(input.maxPages, 1),
    imagesOnly: toBoolean(input.imagesOnly, false),
    image: toBoolean(input.image, true),
    fetchFullContent: toBoolean(input.fetchFullContent, true),
    concurrency: toPositiveNumber(input.concurrency, 3),
  };

  for (const key of customFieldKeys) {
    if (input[key] !== undefined) normalized[key] = input[key];
  }

  return normalized;
}

function sanitizePublicDefaults(plugin, defaults) {
  const output = { ...defaults };
  const customFields = Array.isArray(plugin && plugin.meta && plugin.meta.customFields)
    ? plugin.meta.customFields
    : [];

  customFields.forEach((field) => {
    if (field && field.key && field.sensitive) {
      delete output[field.key];
    }
  });

  return output;
}

class CrawlerApp {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.config = loadAppConfig(baseDir);
    this.plugins = discoverPlugins(baseDir, this.config);
  }

  getDefaultSite() {
    if (this.plugins.has(this.config.defaultSite)) {
      return this.config.defaultSite;
    }
    const firstSite = this.plugins.keys().next();
    if (!firstSite.done) return firstSite.value;
    throw new Error('未发现可用站点插件');
  }

  listSites() {
    return Array.from(this.plugins.values()).map((plugin) => {
      const customFields = Array.isArray(plugin.meta.customFields) ? plugin.meta.customFields : [];
      return {
        ...plugin.meta,
        customFields,
        defaults: sanitizePublicDefaults(plugin, this.resolveRunOptions(plugin.meta.id, {})),
      };
    });
  }

  getPlugin(siteId) {
    const resolvedSite = siteId || this.getDefaultSite();
    const plugin = this.plugins.get(resolvedSite);
    if (!plugin) {
      throw new Error(`未找到站点插件: ${resolvedSite}`);
    }
    return plugin;
  }

  resolveRunOptions(siteId, rawOptions = {}) {
    const plugin = this.getPlugin(siteId || rawOptions.site);
    const pluginSiteId = plugin.meta.id;
    const customFieldKeys = getPluginCustomFieldKeys(plugin);
    const allowedRunOptionKeys = getAllowedRunOptionKeys(plugin);
    const siteConfig = pickRunOptionKeys(this.config.sites[pluginSiteId] || {}, allowedRunOptionKeys);
    const userInput = pickRunOptionKeys(rawOptions, allowedRunOptionKeys);

    return normalizeRunOptions({
      ...pickRunOptionKeys(plugin.defaultOptions || {}, allowedRunOptionKeys),
      ...pickRunOptionKeys(this.config.crawlerDefaults || {}, allowedRunOptionKeys),
      ...siteConfig,
      ...userInput,
      site: pluginSiteId,
    }, customFieldKeys);
  }

  createRun({ site, rawOptions = {}, onEvent }) {
    const plugin = this.getPlugin(site || rawOptions.site);
    const options = this.resolveRunOptions(plugin.meta.id, rawOptions);
    const outputDir = getSiteOutputDir(this.baseDir, plugin.meta.id);

    ensureSiteDirs(this.baseDir, plugin.meta.id);

    const emit = (event, payload = {}) => {
      if (typeof onEvent === 'function') {
        onEvent(event, {
          ...payload,
          site: plugin.meta.id,
          plugin: plugin.meta,
        });
      }
    };

    const context = {
      baseDir: this.baseDir,
      site: plugin.meta.id,
      plugin: plugin.meta,
      options,
      outputDir,
      emit,
      services: {
        output: {
          outputDir,
          writeArticle: (article) => writeArticleMarkdown({ article, outputDir, siteMeta: plugin.meta }),
          writeArticlesManifest: (articles) => writeArticlesManifest({ articles, outputDir }),
          writeFinalSummaryAndFailures: (articles, failures) => writeFinalSummaryAndFailures({
            articles,
            failures,
            outputDir,
            siteMeta: plugin.meta,
          }),
        },
        images: {
          localize: (overrides = {}) => localizeImagesInOutput({
            outputDir,
            concurrency: overrides.concurrency || options.concurrency,
            emit,
            referer: overrides.referer || plugin.meta.referer || plugin.meta.baseUrl,
          }),
        },
        storage: {
          listArticles: () => listArticlesFromDisk(this.baseDir, plugin.meta.id),
          ensureSiteDirs: () => ensureSiteDirs(this.baseDir, plugin.meta.id),
        },
      },
    };

    const runner = plugin.createRunner(context);
    return {
      site: plugin.meta.id,
      plugin,
      options,
      outputDir,
      runner,
    };
  }

  listArticles(siteId) {
    const plugin = this.getPlugin(siteId);
    return listArticlesFromDisk(this.baseDir, plugin.meta.id);
  }

  recoverArticles(siteId) {
    const plugin = this.getPlugin(siteId);
    return listRecoveredArticles(this.baseDir, plugin.meta.id);
  }

  writeArticlesManifest(siteId, articles) {
    const plugin = this.getPlugin(siteId);
    const outputDir = getSiteOutputDir(this.baseDir, plugin.meta.id);
    return writeArticlesManifest({ articles, outputDir });
  }

  deleteArticle(siteId, fileName) {
    const plugin = this.getPlugin(siteId);
    deleteArticleFile(this.baseDir, plugin.meta.id, fileName);
  }
}

function createCrawlerApp(baseDir = path.resolve(__dirname, '..', '..')) {
  return new CrawlerApp(baseDir);
}

module.exports = {
  CrawlerApp,
  createCrawlerApp,
  normalizeRunOptions,
};
