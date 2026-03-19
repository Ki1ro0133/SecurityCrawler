module.exports = {
  meta: {
    id: 'tttang',
    name: '跳跳糖',
    description: '跳跳糖安全社区文章爬虫插件',
    baseUrl: 'https://tttang.com/',
    referer: 'https://tttang.com/',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const TttangRunner = require('./runner');
    return new TttangRunner(context);
  },
};
