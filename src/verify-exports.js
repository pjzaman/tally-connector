"use strict";

const { TallyClient } = require("./tally-client");
const { normalizeDate } = require("./sync-worker");
const { kinds, buildCollectionRequest, rowsFromXml, watermarkFromXml, findValue, voucherPeriod } = require("./tally-collections");

const companyGuid = process.env.COMPANY_GUID?.trim();
const companyName = process.env.COMPANY_NAME?.trim();

async function main() {
  if (!companyGuid || !companyName) throw new Error("Set COMPANY_GUID and COMPANY_NAME before running bounded export checks.");
  const tallyUrl = new URL(process.env.TALLY_URL || "http://127.0.0.1:9000");
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(tallyUrl.hostname)) throw new Error("This check only connects to Tally on this computer.");
  const tally = new TallyClient({ url: tallyUrl, timeoutMs: Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 30_000)) });

  async function verifyActiveCompany() {
    const companyXml = buildCollectionRequest({ kind: "company", companyName: null });
    const companyResponse = await tally.exportXml(companyXml, { skipCompanyVerification: true });
    const companies = rowsFromXml(companyResponse, "company");
    const match = companies.find((row) => row.guid.toLowerCase() === companyGuid.toLowerCase() && row.summary.name === companyName);
    if (!match) throw new Error(`The active Tally company is not ${companyName} (${companyGuid}).`);
    return match;
  }

  tally.setCompanyVerifier(verifyActiveCompany);
  const company = await verifyActiveCompany();
  console.log(`Active company verified: ${companyName} (${companyGuid}).`);
  const booksFrom = findValue(company.raw, ["BooksFrom"]);
  const period = voucherPeriod(normalizeDate(process.env.VOUCHER_PERIOD_FROM) || normalizeDate(booksFrom));
  console.log(`Tally BooksFrom: ${booksFrom || "(not returned)"}; voucher period used by sync: ${period.fromDate} to ${period.toDate}.`);
  console.log("Each record export is limited to the last five AlterID values for that kind; no record contents are printed.\n");

  const dataKinds = Object.keys(kinds).filter((kind) => kind !== "company");
  for (const kind of dataKinds) {
    const range = kind === "voucher" ? period : {};
    const watermarkXml = buildCollectionRequest({ kind, companyName, watermark: true, ...range });
    const watermark = watermarkFromXml(await tally.exportXml(watermarkXml), kind);
    const lower = Math.max(-1, watermark - 5);
    const sampleXml = buildCollectionRequest({ kind, companyName, minAlterId: lower, maxAlterId: watermark, ...range });
    const records = rowsFromXml(await tally.exportXml(sampleXml), kind);
    if (records.some((record) => record.alterId <= lower || record.alterId > watermark)) {
      throw new Error(`${kind} export returned a record outside the requested AlterID window.`);
    }
    console.log(`${kind}: watermark ${watermark}; parsed ${records.length} record(s) in bounded window.`);
  }
  console.log("All bounded Tally exports completed. No API calls, sync, or sweeps were run.");
}

main().catch((error) => {
  console.error(`Bounded Tally export check failed: ${error.message}`);
  process.exitCode = 1;
});
