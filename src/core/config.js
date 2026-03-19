const fs = require('fs');
const path = require('path');

const CORE_RUN_OPTION_KEYS = [
  'site',
  'startDate',
  'endDate',
  'targetDate',
  'maxPages',
  'imagesOnly',
  'image',
  'fetchFullContent',
  'concurrency',
];

function getPluginCustomFieldKeys(plugin) {
  const customFields = plugin && plugin.meta && Array.isArray(plugin.meta.customFields)
    ? plugin.meta.customFields
    : [];

  return customFields
    .map((field) => (field && typeof field.key === 'string' ? field.key.trim() : ''))
    .filter(Boolean);
}

function getAllowedRunOptionKeys(plugin) {
  return [
    ...CORE_RUN_OPTION_KEYS,
    ...getPluginCustomFieldKeys(plugin),
  ];
}

function pickRunOptionKeys(input = {}, allowedKeys = CORE_RUN_OPTION_KEYS) {
  const out = {};
  for (const key of allowedKeys) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

function normalizeAppConfig(raw = {}) {
  const legacyDefaults = (!raw.crawlerDefaults && !raw.sites)
    ? pickRunOptionKeys(raw)
    : {};

  return {
    defaultSite: raw.defaultSite || 'xianzhi',
    plugins: raw.plugins || {},
    crawlerDefaults: {
      ...legacyDefaults,
      ...(raw.crawlerDefaults || {}),
    },
    sites: raw.sites || {},
  };
}

function loadAppConfig(baseDir) {
  const configPath = path.join(baseDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    return normalizeAppConfig({});
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return normalizeAppConfig(raw);
  } catch (error) {
    throw new Error(`读取配置文件失败: ${error.message}`);
  }
}

module.exports = {
  CORE_RUN_OPTION_KEYS,
  RUN_OPTION_KEYS: CORE_RUN_OPTION_KEYS,
  getAllowedRunOptionKeys,
  getPluginCustomFieldKeys,
  loadAppConfig,
  normalizeAppConfig,
  pickRunOptionKeys,
};
