module.exports = {
  meta: {
    id: 'butian',
    name: '补天社区',
    description: '补天社区实战攻防文章爬虫插件',
    baseUrl: 'https://forum.butian.net/community',
    referer: 'https://forum.butian.net/community',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const ButianRunner = require('./runner');
    return new ButianRunner(context);
  },
};
