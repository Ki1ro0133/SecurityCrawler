module.exports = {
  meta: {
    id: 'freebuf',
    name: 'FreeBuf',
    description: 'FreeBuf 技术文章爬虫插件',
    baseUrl: 'https://www.freebuf.com/articles',
    referer: 'https://www.freebuf.com/',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const FreebufRunner = require('./runner');
    return new FreebufRunner(context);
  },
};
