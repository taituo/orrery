// Runtime configuration. In containers this file is generated from environment variables
// (see deploy/docker/web-entrypoint.sh). Leave apiUrl empty to use the same origin.
window.__ORRERY_CONFIG__ = window.__ORRERY_CONFIG__ || {
  apiUrl: "",
  oidc: null, // { issuer: "https://idp.example.com/realms/orrery", clientId: "orrery-web", scope: "openid profile email" }
  langfuseUrl: null,
  mock: false,
};
