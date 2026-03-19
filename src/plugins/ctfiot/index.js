module.exports = {
  meta: {
    id: 'ctfiot',
    name: 'CTFIOT Blog',
    description: 'CTFIOT blog 文章爬虫插件',
    baseUrl: 'https://www.ctfiot.com/blog',
    referer: 'https://www.ctfiot.com/blog',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const CtfiotRunner = require('./runner');
    return new CtfiotRunner(context);
  },
};
