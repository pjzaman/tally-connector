"use strict";

const { TallyClient } = require("./tally-client");
const { buildCollectionRequest, rowsFromXml } = require("./tally-collections");

async function main() {
  const companyName = process.env.COMPANY_NAME?.trim();
  if (!companyName) throw new Error("Set COMPANY_NAME to the exact company name shown in Tally before running this check.");

  const tallyUrl = new URL(process.env.TALLY_URL || "http://127.0.0.1:9000");
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(tallyUrl.hostname)) {
    throw new Error("This safety check only connects to Tally on this computer (localhost).");
  }

  const tally = new TallyClient({ url: tallyUrl, timeoutMs: Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 30_000)) });
  const xml = buildCollectionRequest({ kind: "company", companyName: null });
  const response = await tally.exportXml(xml);
  const companies = rowsFromXml(response, "company");
  const match = companies.find((company) => company.summary.name === companyName);
  if (!match) throw new Error(`Tally accepted the read-only export, but did not return the configured company name: ${companyName}.`);

  const expectedGuid = process.env.COMPANY_GUID?.trim();
  if (expectedGuid && match.guid.toLowerCase() !== expectedGuid.toLowerCase()) {
    throw new Error(`The open Tally company GUID does not match COMPANY_GUID for ${companyName}.`);
  }

  console.log("Tally accepted one read-only Export request.");
  console.log(`Company: ${match.summary.name}`);
  console.log(`GUID: ${match.guid}`);
  console.log("No ERP API calls, sync, or sweeps were run.");
}

main().catch((error) => {
  console.error(`Tally read-only check failed: ${error.message}`);
  process.exitCode = 1;
});
