'use strict';

const SUPPORTED_CODES = new Set(['pl', 'en', 'tr', 'de', 'fr']);

const languageVerificationPlugin = Object.freeze({
  id: 'language',
  label: 'Language Verification',
  description: 'Dodatkowy wybór języka dostępny wyłącznie na oficjalnym serwerze supportu.',
  version: '4.0.0',
  officialOnly: true,
  configurable: false,
  async validate({ evidence, officialGuild }) {
    const languageCode = String(evidence?.languageCode || '').toLowerCase();
    return {
      ok: Boolean(officialGuild && evidence?.rolesApplied && SUPPORTED_CODES.has(languageCode)),
      code: officialGuild ? 'language_role_missing' : 'official_guild_only',
      languageCode,
    };
  },
});

module.exports = { languageVerificationPlugin };
