module.exports = {
  meta: {
    id: 'anquanke',
    name: '安全客',
    description: '安全客文章爬虫插件',
    baseUrl: 'https://www.anquanke.com/',
    referer: 'https://www.anquanke.com/',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const AnquankeRunner = require('./runner');
    return new AnquankeRunner(context);
  },
};
