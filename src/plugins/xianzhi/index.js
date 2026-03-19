module.exports = {
  meta: {
    id: 'xianzhi',
    name: '先知社区',
    description: '阿里云先知社区文章爬虫插件',
    baseUrl: 'https://xz.aliyun.com/news',
    referer: 'https://xz.aliyun.com/',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const XianzhiRunner = require('./runner');
    return new XianzhiRunner(context);
  },
};
