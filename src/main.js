"use strict";

const config = require("./config");
const { ApiClient } = require("./api-client");
const { TallyClient } = require("./tally-client");
const { RequestWorker } = require("./request-worker");
const { SyncWorker } = require("./sync-worker");
const { SweepWorker } = require("./sweep-worker");

const api = new ApiClient({ baseUrl: config.apiUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
const tally = new TallyClient({ url: config.tallyUrl, timeoutMs: config.timeoutMs });
const worker = new RequestWorker({
  api,
  tally,
  companyGuid: config.companyGuid,
  companyName: config.companyName,
  resultPartBytes: config.resultPartBytes,
});
const syncWorker = new SyncWorker({
  api,
  tally,
  companyGuid: config.companyGuid,
  companyName: config.companyName,
  companyBooksFrom: config.companyBooksFrom,
  voucherPeriodFrom: config.voucherPeriodFrom,
});
const sweepWorker = new SweepWorker({
  api,
  tally,
  companyGuid: config.companyGuid,
  companyName: config.companyName,
  companyBooksFrom: config.companyBooksFrom,
});
tally.setCompanyVerifier(() => syncWorker.verifyCompany(true));

let stopping = false;
let active = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function run() {
  console.info(`Tally connector starting for company ${config.companyName}.`);
  console.info(`Features: sync=${config.enableDataSync}, readOnlyQueryQueue=${config.enableQueryQueue}, deletionSweeps=${config.enableDeletionSweeps}.`);
  const health = await api.health();
  console.info(`tallyApi health check: ${health?.ok === false ? "reported not ready" : "reachable"}.`);
  if (config.enableQueryQueue || config.enableDataSync || config.enableDeletionSweeps) {
    await syncWorker.initialize({ enableSync: config.enableDataSync });
  } else {
    console.info("Query queue, data sync, and deletion sweeps are disabled. Enable them only after validating the Tally XML requests and APE API contract.");
  }

  while (!stopping) {
    if (!active) {
      active = true;
      try {
        if (config.enableQueryQueue) {
          const count = await worker.pollOnce();
          if (count) console.info(`Processed ${count} queued export request(s).`);
        }
        if (config.enableDataSync) {
          const kind = await syncWorker.pollOnce();
          if (kind) console.info(`Processed a Tally ${kind} sync window.`);
        }
        if (config.enableDeletionSweeps) {
          sweepWorker.companyBooksFrom = syncWorker.companyBooksFrom;
          const sweepKind = await sweepWorker.pollOnce();
          if (sweepKind) console.info(`Finished Tally ${sweepKind} deletion sweep.`);
        }
      } catch (error) {
        console.error(`Connector poll failed: ${error.message}`);
      } finally {
        active = false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
  console.info("Tally connector stopped.");
}

run().catch((error) => {
  console.error(`Connector could not start: ${error.message}`);
  process.exitCode = 1;
});
