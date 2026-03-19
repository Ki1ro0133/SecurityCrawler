const fs = require('fs');
const path = require('path');

function getPluginConfigEntry(pluginsConfig, pluginId) {
  if (!pluginsConfig) return undefined;
  if (Array.isArray(pluginsConfig)) {
    return pluginsConfig.includes(pluginId) ? { enabled: true } : { enabled: false };
  }
  return pluginsConfig[pluginId];
}

function isPluginEnabled(pluginsConfig, pluginId) {
  const entry = getPluginConfigEntry(pluginsConfig, pluginId);
  if (entry === false) return false;
  if (entry && typeof entry === 'object' && entry.enabled === false) return false;
  return true;
}

function loadPluginModule(pluginPath) {
  const plugin = require(pluginPath);
  if (!plugin || !plugin.meta || !plugin.meta.id || typeof plugin.createRunner !== 'function') {
    throw new Error(`插件 ${pluginPath} 缺少必需导出`);
  }
  return plugin;
}

function discoverPlugins(baseDir, config) {
  const pluginsDir = path.join(baseDir, 'src', 'plugins');
  if (!fs.existsSync(pluginsDir)) return new Map();

  const plugins = new Map();
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    let pluginPath = null;

    if (entry.isDirectory()) {
      pluginPath = path.join(pluginsDir, entry.name, 'index.js');
      if (!fs.existsSync(pluginPath)) continue;
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      pluginPath = path.join(pluginsDir, entry.name);
    }

    if (!pluginPath) continue;

    const plugin = loadPluginModule(pluginPath);
    if (!isPluginEnabled(config.plugins, plugin.meta.id)) continue;

    plugins.set(plugin.meta.id, plugin);
  }

  return plugins;
}

module.exports = {
  discoverPlugins,
  getPluginConfigEntry,
  isPluginEnabled,
};
