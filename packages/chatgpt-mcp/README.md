# Chorum ChatGPT remote MCP adapter

This package is a local-testable Streamable HTTP MCP boundary for ChatGPT. It
uses the existing Self identity flow and the existing Rust `chorum-skill`
signing CLI; it does not implement a second identity provider or expose
credentials to the model.

Self.xyz is a proof/QR/deeplink flow, not the OAuth/OIDC issuer used by a
ChatGPT MCP client. When enabled, Chorum is the OAuth authorization server:
`/oauth/authorize` starts the existing Self bridge request, the browser waits
for its verified callback, and `/oauth/token` exchanges the PKCE-bound code
for a short-lived opaque Chorum bearer token. The token resolves to the
verified Self subject; the encrypted delegation credential never leaves the
server.

The service requires explicit consent for both ongoing automatic voting and use
of permitted history. `answer: null` is the abstention/no-signal path. Reset
removes the encrypted server-side credential and invokes the signer revocation
boundary for recorded votes.

## Local verification

Install dependencies and run `npm test`. Tests use injected mock Self, broker,
and signer implementations; they do not contact Self, Chorum, ChatGPT, or cast
votes. Production must inject:

- a validated ChatGPT OAuth/OIDC user resolver (the bearer token is never a
  Chorum credential); the Self proof callback must remain server-side;
- a real Self authorization/callback implementation that calls the existing
  bridge and broker registration flow;
- `RustCliSigner` with the deployed `chorum-skill` binary; and
- a 32-byte `CHORUM_MCP_MASTER_KEY_B64` from KMS/Secrets Manager, never a source
  file or ordinary environment committed to deployment config.

## ChatGPT testing prerequisites

Real ChatGPT testing still needs a publicly reachable HTTPS `/mcp` endpoint,
DNS/TLS, a registered OAuth client ID and exact redirect URI, a production
database migration for the encrypted user store, KMS/secret-manager
configuration, and the deployed Self bridge callback URL. Set
`CHORUM_MCP_AUTH_CONFIGURED=1`, `CHORUM_MCP_OAUTH_ISSUER`,
`CHORUM_MCP_OAUTH_CLIENT_ID`, and the comma-separated
`CHORUM_MCP_OAUTH_REDIRECT_URIS` only after those values are known. Real Self
login additionally needs a non-mock Self bridge with its fixed scope,
public HTTPS callback endpoint, supported chain/registry configuration, and
the Self app's proof request parameters. The endpoint must then be registered
as a ChatGPT app. None of those deployment or external-vote steps are
performed by this package.
