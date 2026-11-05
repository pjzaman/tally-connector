"use strict";

const kinds = {
  company: { type: "Company", tag: "COMPANY", intervalMs: 0, methods: ["GUID", "Name", "BooksFrom", "StartingFrom"] },
  voucher: {
    type: "Voucher", tag: "VOUCHER", intervalMs: 45_000,
    methods: ["GUID", "MasterID", "AlterID", "VoucherTypeName", "BaseVoucherType", "Date", "VoucherNumber", "PartyLedgerName", "Amount", "Narration", "IsCancelled", "IsOptional", "AllLedgerEntries", "AllInventoryEntries", "BillAllocations", "BatchAllocations", "CostCentreAllocations"],
  },
  ledger: { type: "Ledger", tag: "LEDGER", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  group: { type: "Group", tag: "GROUP", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  stockItem: { type: "StockItem", tag: "STOCKITEM", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent", "BaseUnits"] },
  stockGroup: { type: "Stock Group", tag: "STOCKGROUP", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  stockCategory: { type: "Stock Category", tag: "STOCKCATEGORY", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  godown: { type: "Godown", tag: "GODOWN", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  unit: { type: "Unit", tag: "UNIT", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  costCentre: { type: "Cost Centre", tag: "COSTCENTRE", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  voucherType: { type: "Voucher Type", tag: "VOUCHERTYPE", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
  currency: { type: "Currency", tag: "CURRENCY", intervalMs: 300_000, methods: ["GUID", "MasterID", "AlterID", "Name", "Parent"] },
};

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function methodTags(methods) {
  return methods.map((method) => `<NATIVEMETHOD>${method}</NATIVEMETHOD>`).join("");
}

function tallyDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) throw new Error(`Invalid ISO date: ${isoDate}`);
  const [, year, month, day] = match;
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1];
  if (!monthName || Number(day) < 1 || Number(day) > 31) throw new Error(`Invalid ISO date: ${isoDate}`);
  return `${Number(day)}-${monthName}-${year}`;
}

// Voucher collections are bound to a date period. Without SVFROMDATE/SVTODATE, Tally uses
// whatever period is selected in its UI, so changes outside it are silently missed.
// Sync reads therefore pass an explicit period (see voucherPeriod) for vouchers.
function voucherPeriod(fromIso, now = new Date()) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromIso || "") ? fromIso : "2000-01-01";
  return { fromDate: from, toDate: `${now.getUTCFullYear() + 1}-12-31` };
}

function buildCollectionRequest({ kind, companyName, minAlterId = null, maxAlterId = null, watermark = false, fromDate = null, toDate = null, guidsOnly = false }) {
  const definition = kinds[kind];
  if (!definition) throw new Error(`Unsupported Tally record kind: ${kind}`);
  const collection = `Codex_${kind.replace(/[^A-Za-z0-9]/g, "_")}`;
  const source = `${collection}_Source`;

  let definitions;
  let requestId = collection;
  if (watermark) {
    requestId = `${collection}_Watermark`;
    definitions = `<COLLECTION NAME="${source}" ISMODIFY="No"><TYPE>${definition.type}</TYPE><NATIVEMETHOD>AlterID</NATIVEMETHOD></COLLECTION><COLLECTION NAME="${requestId}" ISMODIFY="No"><SOURCECOLLECTION>${source}</SOURCECOLLECTION><BY>SyncScope : "All"</BY><AGGRCOMPUTE>HighestAlterID : Max : $AlterID</AGGRCOMPUTE><FETCH>HighestAlterID</FETCH></COLLECTION>`;
  } else if (guidsOnly) {
    const dateRange = kind === "voucher";
    if (dateRange && (!fromDate || !toDate)) throw new Error("Voucher sweeps need both fromDate and toDate.");
    const filterName = `${collection}_DateRange`;
    const filter = dateRange ? `<FILTER>${filterName}</FILTER>` : "";
    const formula = dateRange ? `<SYSTEM TYPE="Formulae" NAME="${filterName}">$Date &gt;= ##SVFromDate AND $Date &lt;= ##SVToDate</SYSTEM>` : "";
    definitions = `<COLLECTION NAME="${collection}" ISMODIFY="No"><TYPE>${definition.type}</TYPE><NATIVEMETHOD>GUID</NATIVEMETHOD>${dateRange ? "<NATIVEMETHOD>Date</NATIVEMETHOD>" : ""}${filter}</COLLECTION>${formula}`;
  } else {
    const filterName = `${collection}_AlterIdRange`;
    const lower = minAlterId == null ? 0 : Math.floor(Number(minAlterId) || 0);
    const upper = maxAlterId == null ? null : Math.max(0, Math.floor(Number(maxAlterId)));
    const formula = upper == null
      ? `$AlterID > ${lower}`
      : `$AlterID > ${lower} AND $AlterID <= ${upper}`;
    const filter = minAlterId == null && upper == null ? "" : `<FILTER>${filterName}</FILTER>`;
    const filterFormula = filter ? `<SYSTEM TYPE="Formulae" NAME="${filterName}">${escapeXml(formula)}</SYSTEM>` : "";
    definitions = `<COLLECTION NAME="${collection}" ISMODIFY="No"><TYPE>${definition.type}</TYPE>${methodTags(definition.methods)}${filter}</COLLECTION>${filterFormula}`;
  }

  if (kind === "voucher" && (fromDate || toDate) && !(fromDate && toDate)) {
    throw new Error("Voucher reads need both fromDate and toDate.");
  }
  const rangeVariables = kind === "voucher" && fromDate && toDate
    ? `<SVFROMDATE TYPE="Date">${tallyDate(fromDate)}</SVFROMDATE><SVTODATE TYPE="Date">${tallyDate(toDate)}</SVTODATE>`
    : "";
  const companyVariable = companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : "";
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${requestId}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyVariable}${rangeVariables}</STATICVARIABLES><TDL><TDLMESSAGE>${definitions}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

function parseTallyXml(xml) {
  const { XMLParser, XMLValidator } = require("fast-xml-parser");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Tally response contains a forbidden XML declaration.");
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error("Tally returned malformed XML.");
  const parsed = parser.parse(xml);
  const envelope = parsed.ENVELOPE || parsed.Envelope || parsed;
  const status = envelope.HEADER?.STATUS ?? envelope.Header?.Status;
  if (status != null && String(status) !== "1") {
    const detail = findValue(envelope, ["DESC", "ERROR", "LINEERROR"]);
    throw new Error(`Tally reported an export error${detail ? `: ${detail}` : "."}`);
  }
  return envelope;
}

function arrayify(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }

function findKey(object, candidates) {
  if (!object || typeof object !== "object") return undefined;
  const wanted = new Set(candidates.map((key) => key.toUpperCase()));
  for (const [key, value] of Object.entries(object)) {
    if (wanted.has(key.replace(/^@_/, "").toUpperCase())) return value;
  }
  return undefined;
}

function scalar(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return scalar(value[0]);
  if (typeof value === "object") {
    if (value["#text"] != null) return String(value["#text"]).trim();
    return "";
  }
  return String(value).trim();
}

function findValue(object, candidates) {
  const direct = findKey(object, candidates);
  if (direct !== undefined) return scalar(direct);
  if (!object || typeof object !== "object") return "";
  for (const child of Object.values(object)) {
    if (Array.isArray(child)) {
      for (const value of child) { const found = findValue(value, candidates); if (found) return found; }
    } else if (child && typeof child === "object") {
      const found = findValue(child, candidates);
      if (found) return found;
    }
  }
  return "";
}

function findRecords(envelope, kind) {
  const tag = kinds[kind].tag;
  const found = [];
  function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key.replace(/^@_/, "").toUpperCase() === tag) {
        found.push(...arrayify(child));
      } else walk(child);
    }
  }
  walk(envelope.BODY?.DATA || envelope.Body?.Data || envelope.DATA || envelope);
  return found;
}

function guidsFromXml(xml, kind) {
  const envelope = parseTallyXml(xml);
  return findRecords(envelope, kind)
    .map((row) => scalar(findKey(row, ["GUID", "Guid"])))
    .filter(Boolean);
}

function watermarkFromXml(xml, kind) {
  const envelope = parseTallyXml(xml);
  const value = findValue(envelope, ["HighestAlterID"]);
  if (value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Tally did not return a valid ${kind} AlterID watermark.`);
  }
  return parsed;
}

// Tally's own voucher types carry RESERVEDNAME (e.g. a renamed built-in "Sales (Old)" still has
// RESERVEDNAME="Sales"); user-made types have it empty and point at a parent. The base type is the
// reserved name found by walking up the parents. The voucher's own BASEVOUCHERTYPE field is a
// number (always 0 here), so it is not used.
function resolveBaseVoucherType(name, voucherTypes = {}) {
  let current = name;
  for (let depth = 0; current && depth < 20; depth++) {
    const type = voucherTypes[current];
    if (!type) return null;
    if (type.reservedName) return type.reservedName;
    if (!type.parent || type.parent === current) return null;
    current = type.parent;
  }
  return null;
}

function recordFromObject(kind, source, voucherTypes = {}) {
  const get = (...names) => scalar(findKey(source, names));
  const guid = get("GUID", "Guid");
  const alterId = Number(get("ALTERID", "AlterID"));
  if (!guid || !Number.isSafeInteger(alterId) || alterId < 0) return null;

  const masterIdValue = Number(get("MASTERID", "MasterID"));
  const name = get("NAME", "Name") || scalar(findKey(source, ["@_NAME"]));
  const voucherType = get("VOUCHERTYPENAME", "VoucherTypeName");
  const parent = get("PARENT", "Parent");
  const serialized = JSON.stringify(source);
  const rawTooLarge = Buffer.byteLength(serialized, "utf8") > 800_000;

  let summary;
  if (kind === "voucher") {
    summary = {
      voucherType,
      baseVoucherType: resolveBaseVoucherType(voucherType, voucherTypes) || voucherType,
      voucherNumber: get("VOUCHERNUMBER", "VoucherNumber"),
      date: get("DATE", "Date"),
      partyName: get("PARTYLEDGERNAME", "PartyLedgerName", "PARTYNAME", "PartyName"),
      amount: get("AMOUNT", "Amount"),
      narration: get("NARRATION", "Narration"),
      isCancelled: get("ISCANCELLED", "IsCancelled") || "No",
      isOptional: get("ISOPTIONAL", "IsOptional") || "No",
    };
  } else {
    summary = { name, parent };
    if (kind === "stockItem") summary.baseUnits = get("BASEUNITS", "BaseUnits");
    if (kind === "voucherType") summary.reservedName = get("RESERVEDNAME");
  }

  return {
    kind,
    guid,
    ...(Number.isSafeInteger(masterIdValue) && masterIdValue >= 0 ? { masterId: masterIdValue } : {}),
    alterId,
    deleted: false,
    summary,
    ...(rawTooLarge ? { rawTooLarge: true } : { raw: source }),
  };
}

function rowsFromXml(xml, kind, voucherTypes = {}) {
  const envelope = parseTallyXml(xml);
  return findRecords(envelope, kind)
    .map((row) => recordFromObject(kind, row, voucherTypes))
    .filter(Boolean);
}

module.exports = {
  kinds,
  buildCollectionRequest,
  tallyDate,
  parseTallyXml,
  rowsFromXml,
  guidsFromXml,
  watermarkFromXml,
  findValue,
  findKey,
  scalar,
  recordFromObject,
  resolveBaseVoucherType,
  voucherPeriod,
};
