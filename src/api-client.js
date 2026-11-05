"use strict";

const { request } = require("./http");

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class ApiClient {
  constructor({ baseUrl, apiKey, timeoutMs }) {
    this.baseUrl = new URL(baseUrl);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async call(path, { method = "GET", body, allowNotFound = false, authenticate = true } = {}) {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl.href.endsWith("/") ? this.baseUrl : `${this.baseUrl.href}/`);
    const options = {
      method,
      headers: {
        ...(authenticate ? { "X-Tally-Key": this.apiKey } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { response, body: text } = await request(url, options, this.timeoutMs);
        if (allowNotFound && response.status === 404) return null;
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        if (response.ok) return parsed;
        const error = new Error(`tallyApi ${method} ${path} returned HTTP ${response.status}`);
        error.status = response.status;
        error.response = parsed;
        if (response.status < 500 || attempt === 4) throw error;
        await delay(Math.min(15_000, 1_000 * (2 ** attempt)));
      } catch (error) {
        if (error.status !== undefined || attempt === 4) throw error;
        await delay(Math.min(15_000, 1_000 * (2 ** attempt)));
      }
    }
    throw new Error(`tallyApi ${method} ${path} failed after retries.`);
  }

  health() { return this.call("health", { authenticate: false }); }
  cursor(companyGuid) { return this.call(`cursor?companyGuid=${encodeURIComponent(companyGuid)}`); }
  saveCursor(checkpoint) { return this.call("cursor", { method: "POST", body: checkpoint }); }
  ingest(batch) { return this.call("ingest", { method: "POST", body: batch }); }
  sweep(page) { return this.call("sweep", { method: "POST", body: page }); }
  requests() { return this.call("requests"); }
  result(id, body) {
    return this.call(`requests/${encodeURIComponent(id)}/result`, { method: "POST", body });
  }
}

module.exports = { ApiClient };
