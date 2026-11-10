"use strict";

const { kinds, buildCollectionRequest, voucherPeriod } = require("./tally-collections");

const companyName = process.env.COMPANY_NAME || "<each loaded company name>";
const reviewDate = process.env.DRY_RUN_DATE || new Date().toISOString().slice(0, 10);

function shiftMonth(date, offset) {
  const [year, month] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthRange(yearMonth, endDate = null) {
  const [year, month] = yearMonth.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { fromDate: `${yearMonth}-01`, toDate: endDate || `${yearMonth}-${String(last).padStart(2, "0")}` };
}

function addRequest(label, options) {
  const xml = buildCollectionRequest(options);
  const requestTags = [...xml.matchAll(/<TALLYREQUEST\b[^>]*>([\s\S]*?)<\/TALLYREQUEST>/gi)];
  if (requestTags.length !== 1 || requestTags[0][1].trim().toUpperCase() !== "EXPORT") {
    throw new Error(`${label} is not exactly one TALLYREQUEST=Export.`);
  }
  if (/<(?:IMPORTDATA|REQUESTDATA|FUNCTION)\b/i.test(xml) || /\bACTION\s*=\s*["'](?:Create|Alter|Delete|Cancel)["']/i.test(xml)) {
    throw new Error(`${label} contains a write-capable Tally operation.`);
  }
  requests.push({ label, xml });
}

const requests = [];
addRequest("Active company identity lookup", { kind: "company", companyName: null });

const period = voucherPeriod(process.env.VOUCHER_PERIOD_FROM || process.env.COMPANY_BOOKS_FROM, new Date(`${reviewDate}T00:00:00Z`));
for (const kind of Object.keys(kinds).filter((item) => item !== "company")) {
  const range = kind === "voucher" ? period : {};
  addRequest(`${kind}: initial-load watermark`, { kind, companyName, watermark: true, ...range });
  addRequest(`${kind}: initial-load sample (AlterID -1 through 4999)`, { kind, companyName, minAlterId: -1, maxAlterId: 4999, ...range });
  addRequest(`${kind}: incremental poll sample (AlterID greater than 0)`, { kind, companyName, minAlterId: 0, ...range });
  if (kind === "voucher") {
    for (const offset of [-1, 0]) {
      const range = monthRange(shiftMonth(reviewDate, offset), offset === 0 ? reviewDate : null);
      addRequest(`voucher: deletion-sweep GUID listing ${range.fromDate} through ${range.toDate}`, {
        kind, companyName, ...range, guidsOnly: true,
      });
    }
  } else {
    addRequest(`${kind}: deletion-sweep GUID listing`, { kind, companyName, guidsOnly: true });
  }
}

console.log("OFFLINE TALLY XML REVIEW — no network connections are made; nothing is sent to Tally or the API.\n");
console.log(`Configured company label: ${companyName}`);
console.log(`Date used for sample voucher ranges: ${reviewDate}`);
console.log(`Generated and checked ${requests.length} read-only Export request templates.\n`);
for (const { label, xml } of requests) {
  console.log(`===== ${label} =====`);
  console.log(xml);
  console.log();
}
console.log("Queued owner reports are supplied by the API at runtime. They are separately parsed and rejected unless they are read-only Export XML.");
