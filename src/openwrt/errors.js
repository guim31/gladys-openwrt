// -----------------------------------------------------------------------------
// The errors of the two OpenWrt interfaces (ubus over HTTP, LuCI RPC), sorted
// into a few kinds the rest of the code (and the user) can act on. A message
// never carries the password nor the session token: the clients build it from
// an HTTP status, a JSON-RPC error code, a ubus status code or a socket code.
// -----------------------------------------------------------------------------

export const ERROR_KINDS = Object.freeze({
  // Nothing answers at this address and port (refused, timeout, no route).
  UNREACHABLE: 'unreachable',
  // HTTPS answers, but its certificate does not verify.
  TLS: 'tls',
  // Something answers, but neither /ubus nor the LuCI RPC API is there
  // (uhttpd-mod-ubus missing, another web server, not an OpenWrt device).
  NOT_OPENWRT: 'not_openwrt',
  // rpcd refused the user name or the password.
  AUTH: 'auth',
  // The user logged in, but its rpcd ACL does not grant this object or method.
  PERMISSION: 'permission',
  // The ubus object or method does not exist on this device (no Wi-Fi, no
  // hostapd ubus support, no LuCI…).
  NOT_FOUND: 'not_found',
  // Any other refusal or unexpected answer.
  PROTOCOL: 'protocol',
});

export class OpenwrtError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message safe to log: never a password nor a session token
   */
  constructor(kind, message) {
    super(message);
    this.name = 'OpenwrtError';
    this.kind = kind;
  }
}

// Node error codes of a peer that does not answer (or no longer does).
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
]);

// OpenSSL verification failures: the peer speaks TLS, its certificate is not trusted.
const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Turn a socket or TLS error into an OpenwrtError.
 * @param {Error & { code?: string }} err
 * @param {string} where e.g. "ubus over HTTPS"
 */
export function networkError(err, where) {
  if (err instanceof OpenwrtError) {
    return err;
  }
  const code = err?.code ?? '';
  if (CERTIFICATE_CODES.has(code)) {
    return new OpenwrtError(ERROR_KINDS.TLS, `${where}: certificate not trusted (${code})`);
  }
  if (UNREACHABLE_CODES.has(code)) {
    return new OpenwrtError(ERROR_KINDS.UNREACHABLE, `${where}: no answer (${code})`);
  }
  // HTTPS on a port that serves plain HTTP (or the reverse): nothing usable there.
  if (/^ERR_SSL_|^EPROTO$/.test(code) || /handshake|ssl|tls/i.test(err?.message ?? '')) {
    return new OpenwrtError(ERROR_KINDS.NOT_OPENWRT, `${where}: TLS handshake failed (${code})`);
  }
  return new OpenwrtError(
    ERROR_KINDS.UNREACHABLE,
    `${where}: ${code || err?.message || 'connection failed'}`,
  );
}
