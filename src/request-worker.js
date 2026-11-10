"use strict";

const { validateReadOnlyExport, splitUtf8 } = require("./read-only-query");

class RequestWorker {
  constructor({ api, tally, companyGuid, companyName, getCompanyContext = null, activateCompany = null, resultPartBytes }) {
    Object.assign(this, { api, tally, companyGuid, companyName, getCompanyContext, activateCompany, resultPartBytes });
  }

  async pollOnce() {
    const payload = await this.api.requests();
    const requests = Array.isArray(payload?.requests)
      ? payload.requests.filter((item) => !this.getCompanyContext || !item || typeof item.companyGuid !== "string" || this.getCompanyContext(item.companyGuid)).slice(0, 5)
      : [];
    for (const item of requests) await this.runOne(item);
    return requests.length;
  }

  async runOne(item) {
    const requestedAt = new Date().toISOString();
    let company = null;
    if (!item || typeof item.id !== "string" || typeof item.xml !== "string") {
      console.warn("Ignoring malformed queued export request.");
      return;
    }

    try {
      company = this.getCompanyContext
        ? await this.getCompanyContext(item.companyGuid)
        : (item.companyGuid === this.companyGuid ? { companyGuid: this.companyGuid, companyName: this.companyName } : null);
      if (!company) throw new Error("Request company is not currently loaded in Tally or is not configured for this connector.");
      const requestInfo = validateReadOnlyExport(item.xml);
      if (requestInfo.companyName && requestInfo.companyName !== company.companyName) {
        throw new Error("Request XML names a different Tally company.");
      }
      if (this.activateCompany) await this.activateCompany(company);
      const requestXml = scopeQueryToCompany(item.xml, requestInfo.companyName, company.companyName);
      const response = await this.tally.exportXml(requestXml);
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
      console.info(`Completed read-only export ${item.id} requested by ${String(item.requestedBy || "unknown")} for ${company.companyName} at ${requestedAt} in ${parts.length} part(s).`);
    } catch (error) {
      const companyName = company?.companyName || this.companyName || "unknown company";
      console.error(`Export request ${item.id} requested by ${String(item.requestedBy || "unknown")} for ${companyName} at ${requestedAt} failed: ${error.message}`);
      await this.api.result(item.id, { ok: false, error: error.message, final: true });
    }
  }
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function scopeQueryToCompany(xml, explicitCompanyName, companyName) {
  if (explicitCompanyName) return xml;
  // A company collection is intentionally allowed to list every loaded company.
  if (/<TYPE\b[^>]*>\s*Company\s*<\/TYPE>/i.test(xml)) return xml;
  const variables = /<STATICVARIABLES\b[^>]*>/i;
  if (!variables.test(xml)) throw new Error("Read-only query has no STATICVARIABLES block to scope it to the requested company.");
  return xml.replace(variables, (opening) => `${opening}<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`);
}

module.exports = { RequestWorker, scopeQueryToCompany };
