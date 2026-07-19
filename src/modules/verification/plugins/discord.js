'use strict';

const discordVerificationPlugin = Object.freeze({
  id: 'discord',
  label: 'Discord Verification',
  description: 'Weryfikacja jednym kliknięciem bez opuszczania Discorda.',
  version: '4.2.0',
  nonOfficialOnly: true,
  configurable: false,
  async validate({ session, evidence, officialGuild }) {
    const interactionUserId = String(evidence?.interactionUserId || '');
    return {
      ok: Boolean(!officialGuild && interactionUserId && interactionUserId === session.userId),
      code: officialGuild ? 'support_web_required' : 'discord_user_mismatch',
      userId: interactionUserId,
    };
  },
});

module.exports = { discordVerificationPlugin };
