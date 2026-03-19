# SecurityCrawler

`SecurityCrawler` 是一个可扩展的多站点安全文章采集应用。当前内置 `xianzhi`、`ctfiot`、`freebuf`、`huoxian`、`anquanke`、`butian`、`tttang` 与 `seebug` 八个真实插件，分别用于抓取先知社区（`xz.aliyun.com`）、CTFIOT Blog（`www.ctfiot.com/blog`）、FreeBuf 技术文章（`www.freebuf.com/articles`）、火线 Zone 社区（`zone.huoxian.cn`）、安全客知识文章（`www.anquanke.com`）、补天社区实战攻防文章（`forum.butian.net/community`）、跳跳糖安全社区（`tttang.com`）与 Seebug Paper RSS 文章（`paper.seebug.org/rss/`）并转换为 Markdown。

## 特性

- 宿主应用与站点插件分离，站点实现位于 `src/plugins/<site>/`
- CLI 与 Web 都支持显式选择站点
- 输出目录按站点隔离，避免多站点文件冲突
- 保留先知社区现有的 Playwright 抓取、Markdown 转换与图片本地化能力
- 新增 CTFIOT Blog 的 HTTP 抓取插件，覆盖 `/blog` 与 `/blog/page/<n>` 列表分页
- 新增 FreeBuf 的 HTTP 抓取插件，直接调用真实分页接口，并在详情页被站点拦截时自动回退到列表摘要
- 新增 火线 Zone 的 API 抓取插件，直接消费 `discussions + included.firstPost` 数据，并默认忽略公告/讨论区类帖子
- 新增 安全客的 API 抓取插件，直接消费 `posts + post` 详情接口并跟随接口 `next` 分页
- 新增 补天社区的 HTTP 抓取插件，直接提取详情页 `#md_view_content` 中的站点原生 Markdown
- 新增 跳跳糖的 HTTP 抓取插件，直接解析 `/?page=<n>` 列表页和文章详情页 `article.articles`
- 新增 Seebug Paper 的 RSS 抓取插件，默认稳定消费官方 RSS，并支持通过 Playwright 注入 cookies 抓取详情正文

## 安装

```bash
npm install
npm run install-browsers
```

## 使用

CLI：

```bash
npm start -- --site=xianzhi
node index.js --site=xianzhi --target-date=2024-01-01 --max-pages=5
node index.js --site=xianzhi --images-only
node index.js --site=ctfiot --max-pages=2 --image=false
node index.js --site=freebuf --max-pages=2 --image=false
node index.js --site=huoxian --max-pages=2 --image=false
node index.js --site=anquanke --max-pages=1 --image=false
node index.js --site=butian --max-pages=2 --image=false
node index.js --site=tttang --max-pages=2 --image=false
node index.js --site=seebug --image=false
SEEBUG_COOKIES='__jsluid_s=...; __jsl_clearance_s=...' node index.js --site=seebug --image=false
```

Web：

```bash
npm run web
```

默认情况下会从 `config.json` 读取 `defaultSite` 与全局爬虫默认参数；CLI 与环境变量仍会覆盖配置文件。

## 参数

- `--site=<id>`：站点插件 ID，当前内置 `xianzhi`、`ctfiot`、`freebuf`、`huoxian`、`anquanke`、`butian`、`tttang`、`seebug`
- `--start-date=YYYY-MM-DD`
- `--end-date=YYYY-MM-DD`
- `--target-date=YYYY-MM-DD`
- `--max-pages=10`
- `--images-only`
- `--image=true|false`
- `--fetch-full-content=true|false`
- `--concurrency=3`

环境变量支持与旧版一致的大小写变体，例如 `SITE`、`START_DATE`、`MAX_PAGES`、`IMAGES_ONLY`、`CONCURRENCY`。

Seebug 额外支持两种 cookies 注入方式，用于通过 Playwright 抓详情页正文：

- `SEEBUG_COOKIES`
  传标准请求头格式，例如 `name=value; name2=value2`
- `SEEBUG_COOKIES_JSON`
  传 Playwright `context.cookies()` 导出的 JSON 数组，或 `storageState` 中的 `cookies` 结构

如果未提供 Seebug cookies，插件会自动回退到官方 RSS 摘要模式。

Web UI 会根据插件声明的 `meta.customFields` 自动渲染站点专用输入项；当前选择 `seebug` 时会出现 `Seebug Cookies` 输入框，支持直接粘贴同样的 Cookie 字符串或 JSON。

## 配置文件

```json
{
  "defaultSite": "xianzhi",
  "plugins": {
    "xianzhi": {
      "enabled": true
    },
    "ctfiot": {
      "enabled": true
    },
    "freebuf": {
      "enabled": true
    },
    "huoxian": {
      "enabled": true
    },
    "anquanke": {
      "enabled": true
    },
    "butian": {
      "enabled": true
    },
    "seebug": {
      "enabled": true
    }
  },
  "crawlerDefaults": {
    "maxPages": 1,
    "imagesOnly": false,
    "image": true,
    "fetchFullContent": true,
    "concurrency": 3
  },
  "sites": {
    "xianzhi": {
      "startDate": null,
      "endDate": null,
      "targetDate": null
    },
    "ctfiot": {
      "startDate": null,
      "endDate": null,
      "targetDate": null
    },
    "freebuf": {
      "startDate": null,
      "endDate": null,
      "targetDate": null
    },
    "huoxian": {
      "startDate": null,
      "endDate": null,
      "targetDate": null
    },
    "anquanke": {
      "startDate": null,
      "endDate": null,
      "targetDate": null
    },
    "butian": {
      "startDate": null,
      "endDate": null,
      "targetDate": null
    },
    "seebug": {
      "startDate": null,
      "endDate": null,
      "targetDate": null
    }
  }
}
```

## 输出结构

输出目录改为按站点隔离：

```text
data/
├─ xianzhi/
│  ├─ articles.json
│  ├─ papers/
│  │  ├─ 某文章.md
│  │  └─ images/
│  ├─ SUMMARY-2026-03-19T10-00-00-000Z.md
│  └─ failures-2026-03-19T10-00-00-000Z.json
├─ ctfiot/
│  ├─ articles.json
│  ├─ papers/
│  ├─ SUMMARY-2026-03-19T10-00-00-000Z.md
│  └─ failures-2026-03-19T10-00-00-000Z.json
├─ freebuf/
│  ├─ articles.json
│  ├─ papers/
│  ├─ SUMMARY-2026-03-19T10-00-00-000Z.md
│  └─ failures-2026-03-19T10-00-00-000Z.json
├─ huoxian/
│  ├─ articles.json
│  ├─ papers/
│  ├─ SUMMARY-2026-03-19T10-00-00-000Z.md
│  └─ failures-2026-03-19T10-00-00-000Z.json
├─ anquanke/
│  ├─ articles.json
│  ├─ papers/
│  ├─ SUMMARY-2026-03-19T10-00-00-000Z.md
│  └─ failures-2026-03-19T10-00-00-000Z.json
├─ butian/
│  ├─ articles.json
│  ├─ papers/
│  ├─ SUMMARY-2026-03-19T10-00-00-000Z.md
│  └─ failures-2026-03-19T10-00-00-000Z.json
└─ seebug/
   ├─ articles.json
   ├─ papers/
   ├─ SUMMARY-2026-03-19T10-00-00-000Z.md
   └─ failures-2026-03-19T10-00-00-000Z.json
```

## 高层设计

为了让后续站点能以“插件”的形式接入，而不是继续把宿主变成新的单站点项目，这个项目应该长期保持下面几个原则：

- 宿主负责通用能力，插件负责站点规则
- 宿主只关心插件发现、参数合并、输出目录、文章持久化、图片本地化、CLI/Web 入口
- 插件只关心目标站点如何翻页、如何抽取列表、如何抽取详情、如何把站点 HTML 转成 Markdown
- 站点专有逻辑必须留在 `src/plugins/<site>/`，不要再放回 `src/utils/`
- 每个站点独立写入 `data/<site>/`，避免不同站点互相污染
- 宿主和插件之间通过稳定的最小契约交互，减少新增插件时修改宿主代码的概率

从 high level 角度，推荐把每个插件稳定地拆成 4 层：

1. `index.js`
   只暴露插件元数据、默认参数和 `createRunner(context)`
2. `runner.js`
   站点主流程，负责导航、抓列表、抓详情、发事件
3. `markdown.js`
   站点专用 HTML/富文本转 Markdown
4. `helpers` / `selectors`
   可选，把站点正则、选择器、特殊解析拆出去

这样做的收益是：

- 新增插件时优先新增目录，而不是继续改宿主
- 修改某个站点时只影响自己的插件目录
- 宿主可以持续保持“站点无关”

## 插件结构

当前内置插件目录：

```text
src/plugins/xianzhi/
├─ index.js
├─ markdown.js
└─ runner.js

src/plugins/ctfiot/
├─ index.js
├─ markdown.js
└─ runner.js

src/plugins/freebuf/
├─ index.js
├─ markdown.js
└─ runner.js

src/plugins/huoxian/
├─ index.js
├─ markdown.js
└─ runner.js

src/plugins/anquanke/
├─ index.js
├─ markdown.js
└─ runner.js

src/plugins/butian/
├─ index.js
├─ markdown.js
└─ runner.js

src/plugins/seebug/
├─ index.js
├─ markdown.js
└─ runner.js
```

后续新增站点时，按同样结构放入 `src/plugins/<site>/` 并导出：

- `meta`
- `defaultOptions`
- `createRunner(context)`

## 插件契约

最小插件入口示例：

```js
module.exports = {
  meta: {
    id: 'example',
    name: '示例站点',
    description: '示例插件',
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
```

`context` 由宿主注入，当前包含：

- `context.baseDir`
- `context.site`
- `context.plugin`
- `context.options`
- `context.outputDir`
- `context.emit(event, payload)`
- `context.services.output.writeArticle(article)`
- `context.services.output.writeArticlesManifest(articles)`
- `context.services.output.writeFinalSummaryAndFailures(articles, failures)`
- `context.services.images.localize(overrides)`
- `context.services.storage.listArticles()`
- `context.services.storage.ensureSiteDirs()`

Runner 最少建议实现：

- `async run()`
- `stop()`

Runner 运行中建议统一发这些事件：

- `run_start`
- `article_saved`
- `progress`
- `failure`
- `image_localize_start`
- `image_localized`
- `image_localize_complete`
- `run_complete`

## 插件开发指南

新增一个站点插件时，建议按下面顺序做：

1. 新建目录 `src/plugins/<site>/`
2. 先写 `index.js`，把 `meta` 和 `defaultOptions` 定下来
3. 写 `runner.js`，先跑通最小版本：
   只抓列表、保存基础文章元数据、生成 `articles.json`
4. 再补详情页抓取
5. 如果目标站点有专有富文本结构，再写 `markdown.js`
6. 最后接入图片本地化和失败处理

推荐的最小实现步骤：

1. 先确认列表页能稳定拿到：
   `title`、`link`、`publishTime`
2. 再补充：
   `category`、`author`
3. 再处理详情页：
   `content`
4. 最后处理站点特有的边角逻辑：
   反爬、懒加载、虚拟列表、代码块、表格、图片

建议每个插件至少保证文章对象包含：

- `site`
- `title`
- `link`
- `publishTime`
- `category`
- `author`
- `extractedAt`
- `content`
- `fileName`

开发插件时建议遵守这些规则：

- 不要在插件里直接决定输出根目录，统一使用 `context.outputDir`
- 不要在插件里自己发明另一套存储格式，统一通过宿主提供的 `services.output.*` 落盘
- 不要把站点专有转换器放到 `src/utils/`
- 不要让插件直接依赖 Web 或 CLI 层
- 不要假设只有自己一个站点存在

## 快速模板

仓库内已经提供了一个默认禁用的可复制模板：

```text
src/plugins/example/
├─ index.js
├─ runner.js
└─ markdown.js
```

启用方式：

1. 复制 `src/plugins/example/` 为你的新目录，例如 `src/plugins/my-site/`
2. 修改 `index.js` 中的 `meta.id`、`name`、`baseUrl`、`referer`
3. 在 `config.json` 中为新插件增加配置并设置 `"enabled": true`
4. 实现 `runner.js` 和 `markdown.js`

如果插件需要额外参数，例如 cookies、token、栏目 ID 或站点专用开关，直接在 `src/plugins/<site>/index.js` 的 `meta.customFields` 中声明即可。宿主会自动完成这些事情：

- CLI 读取同名参数，例如 `--my-custom-token=...`
- `config.json` 的 `sites.<site>.<field>` 透传到运行时
- Web UI 自动渲染对应输入控件
- `context.options.<field>` 在插件运行时可直接读取

`customFields` 目前支持的常用字段如下：

- `key`：运行时参数名，也是 `context.options` 中的键
- `label`：Web UI 展示名
- `type`：`text`、`textarea`、`number`、`checkbox`、`date`、`select`、`password`
- `placeholder`：输入框占位提示
- `description`：Web UI 辅助说明
- `defaultValue`：字段默认值
- `options`：当 `type=select` 时的可选项
- `fullWidth`：是否占整行
- `sensitive`：敏感字段，不会把配置默认值回传给 `/api/sites` 或 Web 初始化数据

示例：

```js
module.exports = {
  meta: {
    id: 'my-site',
    name: 'My Site',
    baseUrl: 'https://example.com',
    referer: 'https://example.com',
    customFields: [
      {
        key: 'sessionCookie',
        label: 'Session Cookie',
        type: 'textarea',
        fullWidth: true,
        placeholder: 'name=value; name2=value2',
        description: '站点需要登录态时可在这里粘贴 Cookie。',
      },
      {
        key: 'channelId',
        label: '栏目 ID',
        type: 'number',
        defaultValue: 1,
      },
    ],
  },
};
```

模板目录本身在 `config.json` 中默认是禁用的，不会出现在宿主的可用站点列表里。

`runner.js` 的实现思路建议是：

- `run()` 中编排完整流程
- 单独拆出 `navigateToListPage()`
- 单独拆出 `extractArticlesFromPage()`
- 单独拆出 `fetchArticleContent(url)`
- 单独拆出站点特有的 `normalizeArticle()` 或 `parse*()` 辅助函数

如果某个站点只需要简单 HTML 抽取，不一定要有 `markdown.js`；但只要它的转换规则明显是站点专有的，就应该放回插件目录，而不是放到宿主共享层。

## 开发边界

为了让插件开发保持低耦合，新增站点时应尽量只改这些位置：

- `src/plugins/<site>/index.js`
- `src/plugins/<site>/runner.js`
- `src/plugins/<site>/markdown.js`
- `config.json`
- `README.md`

通常不应该为了接入一个新站点而修改这些宿主文件：

- `src/core/app.js`
- `src/core/plugin-manager.js`
- `server.js`
- `index.js`
- `public/app.js`

如果你发现新增一个普通站点插件时必须改宿主层，通常意味着当前插件契约还不够稳定，应该优先补宿主接口，而不是让每个插件都复制一次宿主改动。

## 插件提交清单

开发完一个新插件后，提交前至少确认这些点：

- 插件能被宿主自动发现，并出现在 `/api/sites`
- `node index.js --site=<site>` 能正常启动
- 输出目录落在 `data/<site>/`
- 抓取后的 `articles.json` 能生成
- Web 重启后 `/api/articles?site=<site>` 仍能恢复文章列表
- 删除文章不会影响其他站点目录
- 站点专有 HTML 转 Markdown 逻辑没有泄漏到 `src/utils/`
- 失败记录能写入 `failures-<timestamp>.json`
- README 至少补充该插件的站点说明和特殊依赖

如果插件依赖浏览器、登录态、验证码、额外 headers 或特殊 referer，最好在插件目录内单独写注释，避免把这些站点细节写进宿主层。

## 合规声明

本工具仅用于学习与研究，请遵守目标网站的服务条款与当地法律法规。
