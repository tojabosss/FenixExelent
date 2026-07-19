'use strict';

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

class PluginRegistry {
  constructor() {
    this.plugins = new Map();
  }

  register(plugin) {
    if (!plugin || !PLUGIN_ID_PATTERN.test(plugin.id || '')) throw new TypeError('Verification plugin has an invalid id');
    if (typeof plugin.label !== 'string' || !plugin.label.trim()) throw new TypeError(`Verification plugin ${plugin.id} has no label`);
    if (typeof plugin.validate !== 'function') throw new TypeError(`Verification plugin ${plugin.id} has no validate function`);
    if (this.plugins.has(plugin.id)) throw new Error(`Verification plugin already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, Object.freeze({ version: '1.0.0', officialOnly: false, ...plugin }));
    return plugin;
  }

  get(id) {
    return this.plugins.get(id) || null;
  }

  has(id) {
    return this.plugins.has(id);
  }

  list({ officialGuild = false } = {}) {
    return [...this.plugins.values()]
      .filter(plugin => !plugin.officialOnly || officialGuild)
      .map(plugin => ({
        id: plugin.id,
        label: plugin.label,
        description: plugin.description || '',
        version: plugin.version,
        officialOnly: Boolean(plugin.officialOnly),
        configurable: plugin.configurable !== false,
      }));
  }
}

module.exports = { PluginRegistry };
