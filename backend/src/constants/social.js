// Instagram and Messenger in the team inbox (G8, D112), through a Facebook Page: its Messenger,
// and the Instagram professional account linked to it (Meta's docs read 2026-11-02).
const SOCIAL_CHANNELS = Object.freeze(['messenger', 'instagram']);
// A chat's channel (Conversation.channel); chats from before G8 have none = WhatsApp.
const CHAT_CHANNELS = Object.freeze(['whatsapp', ...SOCIAL_CHANNELS]);
const SOCIAL_PROVIDERS = Object.freeze(['meta', 'mock']);
// The lead source of a new customer from each channel.
const SOCIAL_LEAD_SOURCE = Object.freeze({ messenger: 'Messenger', instagram: 'Instagram' });
// Meta: a reply within 24 hours of the customer's last message; a person may still answer for
// 7 days with the HUMAN_AGENT tag (Meta's App Review grants it).
const SOCIAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_MS = 7 * 24 * 60 * 60 * 1000;
// What the Facebook Login asks for, and the Page's webhook fields (Messenger; Instagram's come
// through the app's "instagram" webhook subscription).
const SOCIAL_SCOPES = Object.freeze(['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'instagram_basic', 'instagram_manage_messages']);
const PAGE_WEBHOOK_FIELDS = Object.freeze(['messages', 'messaging_postbacks', 'message_echoes', 'message_reads', 'message_deliveries']);

const isSocialChannel = (channel) => SOCIAL_CHANNELS.includes(channel);

module.exports = {
  SOCIAL_CHANNELS, CHAT_CHANNELS, SOCIAL_PROVIDERS, SOCIAL_LEAD_SOURCE, SOCIAL_WINDOW_MS, HUMAN_AGENT_MS, SOCIAL_SCOPES, PAGE_WEBHOOK_FIELDS, isSocialChannel,
};
