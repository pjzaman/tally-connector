"use strict";

const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { scalar } = require("./tally-collections");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
});

function validateReadOnlyExport(xml) {
  if (typeof xml !== "string" || xml.length === 0 || Buffer.byteLength(xml, "utf8") > 4_000_000) {
    throw new Error("Query XML must be a non-empty string no larger than 4 MB.");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD and entity declarations are not allowed.");
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error("Query is malformed XML.");

  const parsed = parser.parse(xml);
  const envelope = parsed.ENVELOPE || parsed.Envelope;
  const header = envelope?.HEADER || envelope?.Header;
  if (!header) throw new Error("Query must have an ENVELOPE and HEADER.");

  const requests = [];
  function inspect(value) {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const bareKey = key.replace(/^@_/, "").toUpperCase();
      // A repeated tag parses as an array: check every occurrence, not just the first.
      const values = () => (Array.isArray(child) ? child : [child]).map((item) => scalar(item).toUpperCase());
      if (bareKey === "TALLYREQUEST") requests.push(...values());
      if (bareKey === "IMPORTDATA" || bareKey === "REQUESTDATA") {
        throw new Error(`Read-only query rejected because it contains ${bareKey}.`);
      }
      if (bareKey === "FUNCTION") throw new Error("Read-only query cannot define TDL functions.");
      if (bareKey === "ACTION" && values().some((action) => ["CREATE", "ALTER", "DELETE", "CANCEL"].includes(action))) {
        throw new Error("Read-only query contains a mutating action.");
      }
      inspect(child);
    }
  }
  inspect(parsed);
  if (requests.length !== 1 || requests[0] !== "EXPORT") {
    throw new Error("Read-only query must contain exactly one TALLYREQUEST, set to Export.");
  }

  return { companyName: findStaticCompany(envelope) };
}

function findStaticCompany(envelope) {
  const desc = envelope.BODY?.DESC || envelope.Body?.Desc;
  const variables = desc?.STATICVARIABLES || desc?.StaticVariables;
  if (!variables) return null;
  const value = variables.SVCURRENTCOMPANY || variables.SvCurrentCompany;
  if (value && typeof value === "object") return String(value["#text"] || "");
  return value == null ? null : String(value);
}

function splitUtf8(text, maxBytes) {
  const source = Buffer.from(text, "utf8");
  const chunks = [];
  let offset = 0;
  while (offset < source.length) {
    let end = Math.min(offset + maxBytes, source.length);
    if (end < source.length) {
      while (end > offset && (source[end] & 0xc0) === 0x80) end--;
    }
    if (end === offset) throw new Error("Could not split response at a UTF-8 boundary.");
    chunks.push(source.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks.length ? chunks : [""];
}

module.exports = { validateReadOnlyExport, splitUtf8 };
