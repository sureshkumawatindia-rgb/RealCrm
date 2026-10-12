// A person's own settings (CP5, Settings → Your Profile and the top bar): the CRM's language and
// theme, saved on their account so every device shows the same. "system" follows the device.
// Messages to customers are never translated.
const LANGUAGES = Object.freeze(['en', 'hi']);
const THEMES = Object.freeze(['system', 'light', 'dark']);
const DEFAULT_PREFERENCES = Object.freeze({ language: 'en', theme: 'system' });

module.exports = { LANGUAGES, THEMES, DEFAULT_PREFERENCES };
