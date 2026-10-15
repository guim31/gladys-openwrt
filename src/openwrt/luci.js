// -----------------------------------------------------------------------------
// The LuCI RPC API (package luci-mod-rpc), the fallback for an OpenWrt device
// without uhttpd-mod-ubus — the interface of the Home Assistant `luci`
// integration (openwrt-luci-rpc, Apache-2.0).
//
//   - Login: POST /cgi-bin/luci/rpc/auth `{ id, method: "login", params: [user, password] }`
//     answers `{ result: "<token>" }`, or `{ result: null }` when refused.
//   - Call: POST /cgi-bin/luci/rpc/<library>?auth=<token> `{ id, method, params }`
//     answers `{ result, error }`; an unknown or expired token gets HTTP 403.
//
// The token travels in the query string: no URL is ever logged.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, OpenwrtError, networkError } from './errors.js';
import { httpRequest } from './http.js';

export const LUCI_RPC_PATH = '/cgi-bin/luci/rpc';

export class LuciRpcClient {
  /**
   * @param {object} options same as UbusClient
   */
  constructor({ baseUrl, username, password, insecure = false, request, timeoutMs = 10_000 }) {
    this.kind = 'luci';
    this.baseUrl = baseUrl;
    this.secure = baseUrl.startsWith('https:');
    this.where = this.secure ? 'LuCI RPC over HTTPS' : 'LuCI RPC over HTTP';
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.request = request ?? httpRequest;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.id = 0;
  }

  async post(library, method, params, { auth = true } = {}) {
    this.id += 1;
    const query = auth && this.token ? `?auth=${encodeURIComponent(this.token)}` : '';
    let response;
    try {
      response = await this.request(`${this.baseUrl}${LUCI_RPC_PATH}/${library}${query}`, {
        method: 'POST',
        json: { id: this.id, method, params },
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
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
      error.httpsRedirect = !this.secure && location.startsWith('https:');
      throw error;
    }
    if (response.status === 404) {
      throw new OpenwrtError(
        ERROR_KINDS.NOT_OPENWRT,
        `${this.where}: no LuCI RPC API (HTTP 404, luci-mod-rpc missing?)`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      const error = new OpenwrtError(ERROR_KINDS.AUTH, `${this.where}: HTTP ${response.status}`);
      error.expired = true;
      throw error;
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
    if (!answer || typeof answer !== 'object' || !('result' in answer || 'error' in answer)) {
      throw new OpenwrtError(ERROR_KINDS.NOT_OPENWRT, `${this.where}: not a JSON-RPC answer`);
    }
    if (answer.error) {
      const code = answer.error.code;
      throw new OpenwrtError(
        code === -32601 ? ERROR_KINDS.NOT_FOUND : ERROR_KINDS.PROTOCOL,
        `${this.where}: ${library}.${method}: ${answer.error.message ?? 'error'} (${code})`,
      );
    }
    return answer.result;
  }

  async open() {
    const token = await this.post('auth', 'login', [this.username, this.password], {
      auth: false,
    }).catch((err) => {
      // A refused login answers `result: null`; some versions answer 403.
      if (err.kind === ERROR_KINDS.AUTH) {
        throw new OpenwrtError(ERROR_KINDS.AUTH, `${this.where}: login refused`);
      }
      throw err;
    });
    if (typeof token !== 'string' || token === '') {
      throw new OpenwrtError(ERROR_KINDS.AUTH, `${this.where}: login refused`);
    }
    this.token = token;
    return this;
  }

  /**
   * Call a function of a LuCI library (`sys`, `ip`, `uci`). An expired token
   * is renewed once.
   */
  async call(library, method, params = []) {
    if (!this.token) {
      await this.open();
    }
    try {
      return await this.post(library, method, params);
    } catch (err) {
      if (!err.expired) {
        throw err;
      }
    }
    await this.open();
    return this.post(library, method, params);
  }

  async close() {
    this.token = null;
  }
}
