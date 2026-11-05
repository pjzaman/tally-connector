"use strict";

const { validateReadOnlyExport, splitUtf8 } = require("./read-only-query");

class RequestWorker {
  constructor({ api, tally, companyGuid, companyName, resultPartBytes }) {
    Object.assign(this, { api, tally, companyGuid, companyName, resultPartBytes });
  }

  async pollOnce() {
    const payload = await this.api.requests();
    const requests = Array.isArray(payload?.requests) ? payload.requests.slice(0, 5) : [];
    for (const item of requests) await this.runOne(item);
    return requests.length;
  }

  async runOne(item) {
    const requestedAt = new Date().toISOString();
    if (!item || typeof item.id !== "string" || typeof item.xml !== "string") {
      console.warn("Ignoring malformed queued export request.");
      return;
    }

    try {
      if (item.companyGuid !== this.companyGuid) {
        throw new Error("Request company does not match the configured active Tally company.");
      }
      const requestInfo = validateReadOnlyExport(item.xml);
      if (requestInfo.companyName && requestInfo.companyName !== this.companyName) {
        throw new Error("Request XML names a different Tally company.");
      }
      const response = await this.tally.exportXml(item.xml);
      const parts = splitUtf8(response, this.resultPartBytes);
      const sendPart = (part) => this.api.result(item.id, {
          part,
          final: part === parts.length - 1,
          ok: true,
          body: parts[part],
        });
      let result;
      for (let part = 0; part < parts.length; part++) result = await sendPart(part);
      for (let recovery = 0; recovery < 5 && Array.isArray(result?.missingParts) && result.missingParts.length; recovery++) {
        for (const part of result.missingParts) {
          if (!Number.isSafeInteger(part) || part < 0 || part >= parts.length) throw new Error("APE requested an invalid missing result part.");
          result = await sendPart(part);
        }
        result = await sendPart(parts.length - 1);
      }
      if (result?.status === "error") throw new Error(result.error || "APE rejected the query result.");
      if (Array.isArray(result?.missingParts) && result.missingParts.length) throw new Error("APE still reports missing query result parts after recovery.");
      if (result?.status && result.status !== "done") throw new Error(`APE did not complete the query result (status: ${result.status}).`);
      console.info(`Completed read-only export ${item.id} requested by ${String(item.requestedBy || "unknown")} for ${this.companyName} at ${requestedAt} in ${parts.length} part(s).`);
    } catch (error) {
      console.error(`Export request ${item.id} requested by ${String(item.requestedBy || "unknown")} for ${this.companyName} at ${requestedAt} failed: ${error.message}`);
      await this.api.result(item.id, { ok: false, error: error.message, final: true });
    }
  }
}

module.exports = { RequestWorker };
