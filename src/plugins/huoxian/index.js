module.exports = {
  meta: {
    id: 'huoxian',
    name: '火线 Zone',
    description: '火线 Zone 社区文章爬虫插件',
    baseUrl: 'https://zone.huoxian.cn/',
    referer: 'https://zone.huoxian.cn/',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const HuoxianRunner = require('./runner');
    return new HuoxianRunner(context);
  },
};
