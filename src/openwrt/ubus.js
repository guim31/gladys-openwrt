// -----------------------------------------------------------------------------
// ubus over HTTP: the JSON-RPC 2.0 endpoint uhttpd-mod-ubus serves at /ubus,
// the interface LuCI itself uses (https://openwrt.org/docs/techref/ubus).
//
//   - Login: `call` on the object `session`, method `login`, with the null
//     session (32 zeros), answers a `ubus_rpc_session` token. rpcd keeps it
//     300 s after its last use: a reading every minute keeps it alive; a
//     reboot of the router forgets it.
//   - Call: `{ jsonrpc, id, method: "call", params: [token, object, method, args] }`
//     answers `{ result: [status, data?] }`, `status` being a ubus status
//     code (0 ok, 4 not found, 6 permission denied…), or a JSON-RPC `error`
//     from uhttpd: -32000 object not found, -32002 access denied (unknown or
//     expired session, or an object the ACL of the user does not grant).
//
// Checked in the sources of uhttpd (ubus.c) and rpcd (session.c, uci.c).
// The token travels in the body only and is never logged.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, OpenwrtError, networkError } from './errors.js';
import { httpRequest } from './http.js';

export const NULL_SESSION = '00000000000000000000000000000000';

// libubus status codes (enum ubus_msg_status).
export const UBUS_STATUS = Object.freeze({
  OK: 0,
  INVALID_COMMAND: 1,
  INVALID_ARGUMENT: 2,
  METHOD_NOT_FOUND: 3,
  NOT_FOUND: 4,
  NO_DATA: 5,
  PERMISSION_DENIED: 6,
  TIMEOUT: 7,
  NOT_SUPPORTED: 8,
  UNKNOWN_ERROR: 9,
  CONNECTION_FAILED: 10,
});

// JSON-RPC error codes of uhttpd-mod-ubus.
export const JSONRPC_ERRORS = Object.freeze({
  PARSE: -32700,
  REQUEST: -32600,
  METHOD: -32601,
  PARAMS: -32602,
  INTERNAL: -32603,
  OBJECT: -32000,
  SESSION: -32001,
  ACCESS: -32002,
  TIMEOUT: -32003,
});

export class UbusClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl `http://192.0.2.1` (no path)
   * @param {string} options.username
   * @param {string} options.password
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {Function} [options.request] the HTTP seam (src/openwrt/http.js)
   * @param {number} [options.timeoutMs]
   */
  constructor({ baseUrl, username, password, insecure = false, request, timeoutMs = 10_000 }) {
    this.kind = 'ubus';
    this.url = `${baseUrl}/ubus`;
    this.secure = baseUrl.startsWith('https:');
    this.where = this.secure ? 'ubus over HTTPS' : 'ubus over HTTP';
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.request = request ?? httpRequest;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.id = 0;
    /** `object method` pairs refused right after a fresh login: the ACL, not the session. */
    this.denied = new Set();
  }

  /** One JSON-RPC exchange. Resolves the `result` array, or throws an OpenwrtError. */
  async rpc(params, { timeoutMs = this.timeoutMs } = {}) {
    this.id += 1;
    const body = { jsonrpc: '2.0', id: this.id, method: 'call', params };
    let response;
    try {
      response = await this.request(this.url, {
        method: 'POST',
        json: body,
        insecure: this.insecure,
        timeoutMs,
      });
    } catch (err) {
      throw networkError(err, this.where);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = String(response.headers?.location ?? '');
      const error = new OpenwrtError(
        ERROR_KINDS.NOT_OPENWRT,
        `${this.where}: redirected (HTTP ${response.status})`,
      );
      // uhttpd sends plain HTTP to HTTPS when `redirect_https` is set.
      error.httpsRedirect = !this.secure && location.startsWith('https:');
      throw error;
    }
    if (response.status === 404) {
      throw new OpenwrtError(
        ERROR_KINDS.NOT_OPENWRT,
        `${this.where}: no /ubus endpoint (HTTP 404, uhttpd-mod-ubus missing?)`,
      );
    }
    if (response.status !== 200) {
      throw new OpenwrtError(ERROR_KINDS.PROTOCOL, `${this.where}: HTTP ${response.status}`);
    }
    let answer;
    try {
      answer = JSON.parse(response.body);
    } catch {
      throw new OpenwrtError(ERROR_KINDS.NOT_OPENWRT, `${this.where}: the answer is not JSON`);
    }
    if (!answer || typeof answer !== 'object' || answer.jsonrpc !== '2.0') {
      throw new OpenwrtError(ERROR_KINDS.NOT_OPENWRT, `${this.where}: not a JSON-RPC answer`);
    }
    if (answer.error) {
      const error = new OpenwrtError(
        ERROR_KINDS.PROTOCOL,
        `${this.where}: ${params[1]} ${params[2]}: ${answer.error.message ?? 'error'} (${answer.error.code})`,
      );
      error.rpcCode = answer.error.code;
      throw error;
    }
    if (!Array.isArray(answer.result) || typeof answer.result[0] !== 'number') {
      throw new OpenwrtError(ERROR_KINDS.PROTOCOL, `${this.where}: unexpected answer`);
    }
    return answer.result;
  }

  /** Log in: a new session token. */
  async open() {
    let result;
    try {
      result = await this.rpc([
        NULL_SESSION,
        'session',
        'login',
        { username: this.username, password: this.password },
      ]);
    } catch (err) {
      if (err.rpcCode === JSONRPC_ERRORS.OBJECT) {
        throw new OpenwrtError(ERROR_KINDS.NOT_OPENWRT, `${this.where}: rpcd is not running`);
      }
      if (err.rpcCode === JSONRPC_ERRORS.ACCESS) {
        throw new OpenwrtError(
          ERROR_KINDS.PERMISSION,
          `${this.where}: the anonymous session may not log in (rpcd ACL "unauthenticated")`,
        );
      }
      throw err;
    }
    const [status, data] = result;
    if (status === UBUS_STATUS.PERMISSION_DENIED || status === UBUS_STATUS.INVALID_ARGUMENT) {
      throw new OpenwrtError(ERROR_KINDS.AUTH, `${this.where}: login refused`);
    }
    if (status !== UBUS_STATUS.OK || typeof data?.ubus_rpc_session !== 'string') {
      throw new OpenwrtError(
        ERROR_KINDS.PROTOCOL,
        `${this.where}: login failed (status ${status})`,
      );
    }
    // `denied` survives a new login: it is the ACL of the user, not the session.
    this.session = data.ubus_rpc_session;
    return this;
  }

  /**
   * Call a ubus method. An expired session (the router rebooted, or more than
   * 300 s without a call) is renewed once, transparently.
   * @param {string} object e.g. `system`
   * @param {string} method e.g. `info`
   * @param {object} [args]
   * @param {object} [options] { timeoutMs }
   * @returns {Promise<object>} the data of the answer ({} when there is none)
   */
  async call(object, method, args = {}, options = {}) {
    if (!this.session) {
      await this.open();
    }
    const pair = `${object} ${method}`;
    let renewed = false;
    for (;;) {
      let result;
      try {
        result = await this.rpc([this.session, object, method, args], options);
      } catch (err) {
        if (err.rpcCode === JSONRPC_ERRORS.ACCESS) {
          if (!renewed && !this.denied.has(pair)) {
            renewed = true;
            await this.open();
            continue;
          }
          this.denied.add(pair);
          throw new OpenwrtError(
            ERROR_KINDS.PERMISSION,
            `${this.where}: ${pair}: access denied by the rpcd ACL`,
          );
        }
        if (err.rpcCode === JSONRPC_ERRORS.OBJECT) {
          throw new OpenwrtError(ERROR_KINDS.NOT_FOUND, `${this.where}: ${pair}: no such object`);
        }
        if (err.rpcCode === JSONRPC_ERRORS.TIMEOUT) {
          throw new OpenwrtError(ERROR_KINDS.PROTOCOL, `${this.where}: ${pair}: timed out`);
        }
        throw err;
      }
      return statusData(result, pair, this.where);
    }
  }

  /** Forget the session: rpcd drops it after 300 s without use. */
  async close() {
    this.session = null;
  }
}

/** The data of a `[status, data]` result, or the error its status means. */
function statusData([status, data], pair, where) {
  switch (status) {
    case UBUS_STATUS.OK:
      return data && typeof data === 'object' ? data : {};
    case UBUS_STATUS.NO_DATA:
      return {};
    case UBUS_STATUS.METHOD_NOT_FOUND:
    case UBUS_STATUS.NOT_FOUND:
    case UBUS_STATUS.NOT_SUPPORTED:
      throw new OpenwrtError(ERROR_KINDS.NOT_FOUND, `${where}: ${pair}: not found (${status})`);
    case UBUS_STATUS.PERMISSION_DENIED:
      throw new OpenwrtError(ERROR_KINDS.PERMISSION, `${where}: ${pair}: permission denied`);
    default:
      throw new OpenwrtError(ERROR_KINDS.PROTOCOL, `${where}: ${pair}: failed (status ${status})`);
  }
}
