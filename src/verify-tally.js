"use strict";

const { TallyClient } = require("./tally-client");
const { buildCollectionRequest, companiesFromXml } = require("./tally-collections");

async function main() {
  const companyName = process.env.COMPANY_NAME?.trim();
  const companyGuid = process.env.COMPANY_GUID?.trim();

  const tallyUrl = new URL(process.env.TALLY_URL || "http://127.0.0.1:9000");
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(tallyUrl.hostname)) {
    throw new Error("This safety check only connects to Tally on this computer (localhost).");
  }

  const tally = new TallyClient({ url: tallyUrl, timeoutMs: Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 30_000)) });
  const xml = buildCollectionRequest({ kind: "company", companyName: null });
  const response = await tally.exportXml(xml);
  const companies = companiesFromXml(response);
  if (!companies.length) throw new Error("Tally accepted the read-only export but returned no loaded companies.");
  for (const company of companies) {
    console.log(`Company: ${company.summary.name}; GUID: ${company.guid}; BooksFrom: ${company.summary.booksFrom || company.summary.startingFrom || "(not returned)"}`);
  }
  if (companyName || companyGuid) {
    const match = companies.find((company) => (!companyName || company.summary.name === companyName)
      && (!companyGuid || company.guid.toLowerCase() === companyGuid.toLowerCase()));
    if (!match) throw new Error("The optional COMPANY_NAME/COMPANY_GUID selection did not match a loaded company.");
  }
  console.log("Tally accepted one read-only Company collection Export. No ERP API calls, sync, or sweeps were run.");
}

main().catch((error) => {
  console.error(`Tally read-only check failed: ${error.message}`);
  process.exitCode = 1;
});
