// One-time on-chain confirmation that a proof's identity-registry Merkle root is
// live in Self's Celo Identity Registry (Sybil hardening — ARCHITECTURE.md §5).
//
// Called ONLY at registration (POST /verify), never per answer. It anchors the
// off-chain SNARK to the REAL registry (where one-passport→one-identity is
// enforced), so a forged/stale-root proof is rejected.
//
// CONFIRM DURING IMPL (SELF_MIGRATION.md open item #6): the exact registry/hub
// contract address on Celo (Sepolia for staging, mainnet for prod) and the
// recent-roots view to call. This module isolates that lookup; only the 4-byte
// selector + address need filling in once confirmed against @selfxyz on Celo.
//
// No SDK import; uses JSON-RPC via fetch so it is unit-testable with an injected
// fetch.

// Placeholder selector for a `rootIsKnown(uint256)`-style view. Replace with the
// real Identity Registry selector once confirmed (open item).
const ROOT_IS_KNOWN_SELECTOR = "0x00000000";

function toHex32(root) {
  // Accept a decimal string, 0x-hex, or bigint; left-pad to 32 bytes.
  let big;
  if (typeof root === "bigint") big = root;
  else if (typeof root === "string" && root.startsWith("0x")) big = BigInt(root);
  else big = BigInt(root); // decimal string / number
  return big.toString(16).padStart(64, "0");
}

export function encodeRootIsKnown(root) {
  return ROOT_IS_KNOWN_SELECTOR + toHex32(root);
}

export function decodeBool(resultHex) {
  if (!resultHex || typeof resultHex !== "string") return false;
  const h = resultHex.startsWith("0x") ? resultHex.slice(2) : resultHex;
  if (!h) return false;
  try {
    return BigInt("0x" + h) !== 0n;
  } catch {
    return false;
  }
}

/**
 * Confirm `root` against the on-chain registry.
 * Returns `{ confirmed: boolean, reason: string }`.
 * `confirmed` is false (with a reason) whenever the check can't be performed —
 * the broker decides whether to hard-fail (require_registry_confirmation).
 */
export async function confirmRegistry({
  rpcUrl,
  root,
  registryAddress,
  fetchImpl,
} = {}) {
  if (!rpcUrl || !registryAddress) return { confirmed: false, reason: "no_rpc" };
  if (root === undefined || root === null || root === "") {
    return { confirmed: false, reason: "no_root" };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { confirmed: false, reason: "no_fetch" };

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: registryAddress, data: encodeRootIsKnown(root) }, "latest"],
  };
  try {
    const resp = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { confirmed: false, reason: `rpc_http_${resp.status}` };
    const data = await resp.json();
    if (data.error) return { confirmed: false, reason: "rpc_error" };
    const known = decodeBool(data.result);
    return { confirmed: known, reason: known ? "ok" : "root_unknown" };
  } catch (e) {
    return { confirmed: false, reason: `rpc_exception:${String(e?.message || e)}` };
  }
}
