module.exports = {
  meta: {
    id: 'seebug',
    name: 'Seebug Paper',
    description: 'Seebug Paper RSS 文章爬虫插件',
    baseUrl: 'https://paper.seebug.org/',
    referer: 'https://paper.seebug.org/',
    customFields: [
      {
        key: 'seebugCookies',
        label: 'Seebug Cookies',
        type: 'textarea',
        fullWidth: true,
        rows: 5,
        sensitive: true,
        placeholder: '可粘贴标准 Cookie 字符串，如 __jsluid_s=...; __jsl_clearance_s=...，也可粘贴 Playwright cookies JSON。',
        description: '仅该插件使用。支持标准 Cookie 字符串或 Playwright cookies JSON，用于浏览器上下文注入。',
      },
    ],
  },
  defaultOptions: {
    maxPages: 1,
    imagesOnly: false,
    image: true,
    fetchFullContent: true,
    concurrency: 3,
  },
  createRunner(context) {
    const SeebugRunner = require('./runner');
    return new SeebugRunner(context);
  },
};
