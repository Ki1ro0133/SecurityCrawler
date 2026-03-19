const { createCrawlerApp } = require('./src/core/app');

function toKebabCase(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

function parseArgv(args) {
  const out = {};
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.replace(/^--/, '').split('=');
    out[key] = value === undefined ? true : value;
  }
  return out;
}

function envGet(key) {
  const candidates = [
    key,
    key.toUpperCase(),
    key.replace(/-/g, '_').toUpperCase(),
    key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
  ];
  for (const candidate of candidates) {
    if (process.env[candidate] !== undefined) return process.env[candidate];
  }
  return undefined;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const app = createCrawlerApp(__dirname);

  const fromCliOrEnv = (keys, fallback) => {
    for (const key of keys) {
      if (args[key] !== undefined) return args[key];
      const envVal = envGet(key);
      if (envVal !== undefined) return envVal;
    }
    return fallback;
  };

  const rawOptions = {};
  const site = fromCliOrEnv(['site'], undefined);
  const plugin = app.getPlugin(site);
  const startDate = fromCliOrEnv(['startDate', 'start-date'], undefined);
  const endDate = fromCliOrEnv(['endDate', 'end-date'], undefined);
  const targetDate = fromCliOrEnv(['targetDate', 'target-date'], undefined);
  const maxPages = fromCliOrEnv(['maxPages', 'max-pages'], undefined);
  const concurrency = fromCliOrEnv(['concurrency', 'conc', 'parallel'], undefined);
  const image = fromCliOrEnv(['image'], undefined);
  const fetchFullContent = fromCliOrEnv(['fetchFullContent', 'fetch-full-content'], undefined);
  const imagesOnly = args['images-only'] !== undefined ? args['images-only'] : fromCliOrEnv(['imagesOnly'], undefined);

  if (site !== undefined) rawOptions.site = site;
  if (startDate !== undefined) rawOptions.startDate = startDate;
  if (endDate !== undefined) rawOptions.endDate = endDate;
  if (targetDate !== undefined) rawOptions.targetDate = targetDate;
  if (maxPages !== undefined) rawOptions.maxPages = maxPages;
  if (concurrency !== undefined) rawOptions.concurrency = concurrency;
  if (image !== undefined) rawOptions.image = image;
  if (fetchFullContent !== undefined) rawOptions.fetchFullContent = fetchFullContent;
  if (imagesOnly !== undefined) rawOptions.imagesOnly = imagesOnly;

  const customFields = Array.isArray(plugin.meta.customFields) ? plugin.meta.customFields : [];
  for (const field of customFields) {
    const fieldKey = field && field.key;
    if (!fieldKey) continue;
    const fieldValue = fromCliOrEnv([fieldKey, toKebabCase(fieldKey)], undefined);
    if (fieldValue !== undefined) rawOptions[fieldKey] = fieldValue;
  }

  const execution = app.createRun({
    site: rawOptions.site,
    rawOptions,
  });

  console.log('配置:', {
    site: execution.site,
    siteName: execution.plugin.meta.name,
    ...execution.options,
  });

  await execution.runner.run();
}

if (require.main === module) {
  main().catch(console.error);
}
