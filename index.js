const fs = require('fs');
const path = require('path');
const XianzhiCrawler = require('./src/XianzhiCrawler');

async function main() {
  const argv = process.argv.slice(2);

  const parseArgv = (args) => {
    const out = {};
    for (const a of args) {
      if (!a.startsWith('--')) continue;
      const [k, v] = a.replace(/^--/, '').split('=');
      out[k] = v === undefined ? true : v;
    }
    return out;
  };
  const args = parseArgv(argv);

  let fileCfg = {};
  try {
    const cfgPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      fileCfg = JSON.parse(raw);
    }
  } catch (e) {
    console.log('读取 config.json 失败，忽略:', e.message);
  }

  const envGet = (key) => {
    const cased = [
      key,
      key.toUpperCase(),
      key.replace(/-/g, '_').toUpperCase(),
      key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
    ];
    for (const k of cased) {
      if (process.env[k] !== undefined) return process.env[k];
    }
    return undefined;
  };

  const pick = (keys, fallback) => {
    for (const k of keys) {
      if (args[k] !== undefined) return args[k];
      const envVal = envGet(k);
      if (envVal !== undefined) return envVal;
      if (fileCfg[k] !== undefined) return fileCfg[k];
    }
    return fallback;
  };

  const imagesOnlyRaw = args['images-only'] !== undefined ? args['images-only'] : pick(['imagesOnly'], false);
  const imagesOnly = imagesOnlyRaw === true || imagesOnlyRaw === 'true';
  const imageRaw = args['image'] !== undefined ? args['image'] : pick(['image'], false);
  const image = imageRaw === true || imageRaw === 'true';
  const maxPagesRaw = pick(['maxPages', 'max-pages'], 1);
  const maxPages = Number(maxPagesRaw) > 0 ? Number(maxPagesRaw) : 1;
  const startDate = pick(['startDate', 'start-date'], undefined);
  const endDate = pick(['endDate', 'end-date'], undefined);
  const targetDate = pick(['targetDate', 'target-date'], undefined);
  const concurrencyRaw = pick(['concurrency', 'conc', 'parallel'], 3);
  const concurrency = Number(concurrencyRaw) > 0 ? Number(concurrencyRaw) : 3;

  const crawler = new XianzhiCrawler({
    fetchFullContent: !imagesOnly,
    maxPages,
    imagesOnly,
    image,
    startDate,
    endDate,
    targetDate,
    concurrency,
  });
  console.log('配置:', {
    imagesOnly,
    image,
    maxPages,
    startDate,
    endDate,
    targetDate,
    concurrency,
  });
  await crawler.run();
}

if (require.main === module) {
  main().catch(console.error);
}