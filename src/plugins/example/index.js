module.exports = {
  meta: {
    id: 'example',
    name: '示例站点模板',
    description: '用于复制开发新插件的模板，默认禁用',
    baseUrl: 'https://example.com',
    referer: 'https://example.com/',
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const ExampleRunner = require('./runner');
    return new ExampleRunner(context);
  },
};
