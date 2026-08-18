import { createMcpServer, localMasterKey } from "./server.js";
import { ChorumService } from "./service.js";
import { EncryptedUserStore } from "./store.js";
import { SelfIdentityProvider, HttpChorumBroker } from "./http-adapters.js";
import { RustCliSigner } from "./rust-signer.js";
import { createToolDispatcher } from "./tools.js";

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
const server = createMcpServer(dispatcher, async (request) => {
  // Fail closed until a real OAuth/OIDC verifier is installed. This staging
  // build intentionally has no dev bearer-token identity mode.
  if (process.env.CHORUM_MCP_AUTH_CONFIGURED !== "1") return undefined;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return undefined;
  throw new Error("OAuth verifier is not wired; refusing bearer token");
});
server.listen(Number(process.env.PORT ?? 8788), "0.0.0.0");
