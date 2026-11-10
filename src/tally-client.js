"use strict";

const { requestBuffer } = require("./http");

function decodeXml(buffer, contentType = "") {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const littleEndian = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      littleEndian[i - 2] = buffer[i + 1];
      littleEndian[i - 1] = buffer[i];
    }
    return littleEndian.toString("utf16le");
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");
  if (/charset\s*=\s*["']?utf-16be/i.test(contentType)) {
    const littleEndian = Buffer.alloc(buffer.length - (buffer.length % 2));
    for (let i = 0; i + 1 < littleEndian.length; i += 2) {
      littleEndian[i] = buffer[i + 1];
      littleEndian[i + 1] = buffer[i];
    }
    return littleEndian.toString("utf16le");
  }
  if (/charset\s*=\s*["']?utf-16/i.test(contentType)) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

class TallyClient {
  constructor({ url, timeoutMs }) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.companyVerifier = null;
  }

  setCompanyVerifier(verifier) {
    this.companyVerifier = verifier;
  }

  async exportXml(xml, { skipCompanyVerification = false } = {}) {
    if (!skipCompanyVerification && this.companyVerifier) await this.companyVerifier();
    let result;
    try {
      result = await requestBuffer(this.url, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", Accept: "text/xml" },
        body: xml,
      }, this.timeoutMs);
    } catch (cause) {
      const timeout = cause.name === "AbortError" || cause.name === "TimeoutError";
      const error = new Error(timeout
        ? `Tally XML export timed out after ${this.timeoutMs} ms.`
        : `Tally XML export could not reach ${this.url.hostname}:${this.url.port || "80"}: ${cause.cause?.message || cause.message}`);
      error.name = cause.name || "TallyConnectionError";
      error.source = "tally";
      error.cause = cause;
      throw error;
    }
    const { response, body: bytes } = result;
    if (!response.ok) throw new Error(`Tally returned HTTP ${response.status}`);
    const body = decodeXml(bytes, response.headers.get("content-type") || "");
    if (!body.trim()) throw new Error("Tally returned an empty response.");
    if (/<STATUS>\s*0\s*<\/STATUS>/i.test(body)) throw new Error("Tally rejected the XML export request.");
    return body;
  }
}

module.exports = { TallyClient, decodeXml };
