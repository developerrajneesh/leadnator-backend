const https = require("https");

function tlsInsecureEnabled() {
  return process.env.TLS_INSECURE === "true" || process.env.MONGO_TLS_INSECURE === "true";
}

/** Dev fallback when Node cannot verify HTTPS certs (Meta Graph, etc.). Prefer `node --use-system-ca`. */
function applyAxiosTls() {
  if (!tlsInsecureEnabled()) return;
  const agent = new https.Agent({ rejectUnauthorized: false });
  const axios = require("axios");
  axios.defaults.httpsAgent = agent;
}

module.exports = function applyTlsConfig() {
  applyAxiosTls();
  if (tlsInsecureEnabled()) {
    console.warn(
      "⚠️  TLS_INSECURE/MONGO_TLS_INSECURE: axios skips certificate verification (dev only). Prefer: npm run dev (uses --use-system-ca).",
    );
  }
};
