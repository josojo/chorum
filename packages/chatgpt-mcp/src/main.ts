import { createMcpServer, localMasterKey } from "./server.js";
import { ChorumService } from "./service.js";
import { EncryptedUserStore } from "./store.js";
import { SelfIdentityProvider, HttpChorumBroker } from "./http-adapters.js";
import { RustCliSigner } from "./rust-signer.js";
import { createToolDispatcher } from "./tools.js";
import { ChorumOAuthServer } from "./oauth.js";

const brokerUrl = process.env.CHORUM_MCP_BROKER_URL ?? "http://broker:8000";
const bridgeUrl = process.env.CHORUM_MCP_SELF_BRIDGE_URL ?? "http://self-bridge:8787";
const storePath = process.env.CHORUM_MCP_STORE_PATH ?? "/data/users.enc";
const service = new ChorumService(
  new EncryptedUserStore(storePath, localMasterKey()),
  new SelfIdentityProvider(bridgeUrl, brokerUrl),
  new HttpChorumBroker(brokerUrl),
  new RustCliSigner(process.env.CHORUM_MCP_SIGNER_BIN ?? "chorum-skill"),
);

const dispatcher = createToolDispatcher(service);
const oauthConfigured = process.env.CHORUM_MCP_AUTH_CONFIGURED === "1";
const issuer = process.env.CHORUM_MCP_OAUTH_ISSUER?.trim() ?? "";
const oauthClientId = process.env.CHORUM_MCP_OAUTH_CLIENT_ID?.trim() ?? "";
const oauthRedirectUris = new Set((process.env.CHORUM_MCP_OAUTH_REDIRECT_URIS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const oauth = oauthConfigured && issuer && oauthClientId && oauthRedirectUris.size > 0
  ? new ChorumOAuthServer(
    service,
    issuer,
    oauthClientId,
    oauthRedirectUris,
  )
  : undefined;
const server = createMcpServer(dispatcher, async (request) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  return oauth && token ? oauth.resolveBearer(token) : undefined;
}, oauth);
server.listen(Number(process.env.PORT ?? 8788), "0.0.0.0");
