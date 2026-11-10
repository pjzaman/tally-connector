"use strict";

const { TallyClient } = require("./tally-client");
const { normalizeDate } = require("./sync-worker");
const { kinds, buildCollectionRequest, rowsFromXml, companiesFromXml, watermarkFromXml, voucherPeriod } = require("./tally-collections");

const companyGuid = process.env.COMPANY_GUID?.trim();
const companyName = process.env.COMPANY_NAME?.trim();

async function main() {
  if (Boolean(companyGuid) !== Boolean(companyName)) throw new Error("Set both COMPANY_GUID and COMPANY_NAME to check one company, or leave both unset to check every loaded company.");
  const tallyUrl = new URL(process.env.TALLY_URL || "http://127.0.0.1:9000");
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(tallyUrl.hostname)) throw new Error("This check only connects to Tally on this computer.");
  const tally = new TallyClient({ url: tallyUrl, timeoutMs: Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 30_000)) });

  const companyXml = buildCollectionRequest({ kind: "company", companyName: null });
  const companyResponse = await tally.exportXml(companyXml, { skipCompanyVerification: true });
  const loaded = companiesFromXml(companyResponse);
  const selected = companyGuid
    ? loaded.filter((row) => row.guid.toLowerCase() === companyGuid.toLowerCase() && row.summary.name === companyName)
    : loaded;
  if (!selected.length) {
    const returned = loaded.length ? loaded.map((row) => `${row.summary.name} (${row.guid})`).join(", ") : "none";
    throw new Error(`No matching loaded Tally company. Requested: ${companyName || "all"}${companyGuid ? ` (${companyGuid})` : ""}; returned: ${returned}.`);
  }

  const dataKinds = Object.keys(kinds).filter((kind) => kind !== "company");
  console.log(`Verified ${selected.length} loaded company record(s). Each export is read-only, bounded to five AlterIDs, prints counts only, and makes no API calls, sync, or sweeps.\n`);
  for (const company of selected) {
    const booksFrom = company.summary.booksFrom || company.summary.startingFrom;
    const period = voucherPeriod(normalizeDate(process.env.VOUCHER_PERIOD_FROM) || normalizeDate(booksFrom));
    console.log(`Company: ${company.summary.name} (${company.guid}); Tally BooksFrom: ${booksFrom || "(not returned)"}; voucher period: ${period.fromDate} to ${period.toDate}.`);

    for (const kind of dataKinds) {
      const range = kind === "voucher" ? period : {};
      const watermarkXml = buildCollectionRequest({ kind, companyName: company.summary.name, watermark: true, ...range });
      const watermark = watermarkFromXml(await tally.exportXml(watermarkXml), kind);
      const lower = Math.max(-1, watermark - 5);
      const sampleXml = buildCollectionRequest({ kind, companyName: company.summary.name, minAlterId: lower, maxAlterId: watermark, ...range });
      const records = rowsFromXml(await tally.exportXml(sampleXml), kind);
      if (records.some((record) => record.alterId <= lower || record.alterId > watermark)) {
        throw new Error(`${company.summary.name}: ${kind} export returned a record outside the requested AlterID window.`);
      }
      console.log(`  ${kind}: watermark ${watermark}; parsed ${records.length} record(s) in bounded window.`);
    }
    console.log();
  }
  console.log("All bounded Tally exports completed. No records were uploaded; no API calls, sync, or sweeps were run.");
}

main().catch((error) => {
  console.error(`Bounded Tally export check failed: ${error.message}`);
  process.exitCode = 1;
});
