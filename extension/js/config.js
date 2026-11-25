// Build-time configuration. `node tools/configure.js --api https://license.example.com` rewrites API_BASE here
// and the matching host permission in manifest.json.
window.MDM = window.MDM || {};
MDM.config = Object.freeze({
  API_BASE: 'https://dmsender.meapi.in',
  VERSION: chrome.runtime.getManifest().version,
  SUPPORT_EMAIL: 'support@meapi.in',
  BRAND: 'MeAPI DM',
  WEBSITE: 'https://meapi.in',
});
