// ui.js

module.exports = (api) => {
  api.onAction('generateFingerprint', async function () {
    // Generate a new random fingerprint, base64url-encoded (no padding, no + or /)
    const random = require('crypto').randomBytes(12).toString('base64url');
    // Return to UI
    return { fingerprint: random };
  });
};
