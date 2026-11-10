"use strict";

const config = require("./config");
const path = require("node:path");
const { ApiClient } = require("./api-client");
const { TallyClient } = require("./tally-client");
const { ProgressStore } = require("./progress-store");
const { RequestWorker } = require("./request-worker");
const { SyncWorker, syncKinds, normalizeDate } = require("./sync-worker");
const { SweepWorker } = require("./sweep-worker");
const { buildCollectionRequest, companiesFromXml } = require("./tally-collections");

const api = new ApiClient({ baseUrl: config.apiUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
const tally = new TallyClient({ url: config.tallyUrl, timeoutMs: config.tallyTimeoutMs });
const progressStore = new ProgressStore(path.join(__dirname, "..", "state", "initial-sync-progress.json"));
const companies = new Map();
const loadedCompanyGuids = new Set();
let waitUntil = 0;
let stopping = false;

const companyKey = (guid) => String(guid || "").toLowerCase();
const maxDate = (...dates) => dates.filter(Boolean).sort().at(-1) || null;

function activateCompany(context) {
  tally.setCompanyVerifier(() => context.syncWorker.verifyCompany());
}

function createCompanyContext(company) {
  const bookStart = normalizeDate(company.summary.booksFrom || company.summary.startingFrom);
  const context = {
    companyGuid: company.guid,
    companyName: company.summary.name,
    companyBooksFrom: bookStart,
    loaded: true,
  };
  context.syncWorker = new SyncWorker({
    api,
    tally,
    companyGuid: context.companyGuid,
    companyName: context.companyName,
    companyBooksFrom: bookStart,
    voucherPeriodFrom: config.voucherPeriodFrom,
    progressStore,
  });
  context.sweepWorker = new SweepWorker({
    api,
    tally,
    companyGuid: context.companyGuid,
    companyName: context.companyName,
    companyBooksFrom: maxDate(bookStart, config.voucherPeriodFrom),
    voucherPeriodFrom: config.voucherPeriodFrom,
  });
  return context;
}

function updateCompanyContext(context, company) {
  const wasLoaded = context.loaded;
  const nameChanged = context.companyName !== company.summary.name;
  context.companyName = company.summary.name;
  context.companyBooksFrom = normalizeDate(company.summary.booksFrom || company.summary.startingFrom) || context.companyBooksFrom;
  context.loaded = true;
  context.syncWorker.companyName = context.companyName;
  context.syncWorker.companyBooksFrom = context.companyBooksFrom;
  if (nameChanged || !wasLoaded) context.syncWorker.companyVerified = false;
  context.sweepWorker.companyName = context.companyName;
  context.sweepWorker.companyBooksFrom = maxDate(context.companyBooksFrom, config.voucherPeriodFrom);
}

async function discoverLoadedCompanies() {
  const xml = buildCollectionRequest({ kind: "company", companyName: null });
  const response = await tally.exportXml(xml, { skipCompanyVerification: true });
  const records = companiesFromXml(response);
  const nextLoaded = new Set();
  for (const company of records) {
    const key = companyKey(company.guid);
    nextLoaded.add(key);
    const existing = companies.get(key);
    if (existing) updateCompanyContext(existing, company);
    else companies.set(key, createCompanyContext(company));
  }
  loadedCompanyGuids.clear();
  for (const key of nextLoaded) loadedCompanyGuids.add(key);
  for (const [key, context] of companies) context.loaded = nextLoaded.has(key);
  const names = records.map((company) => company.summary.name);
  if (!names.length) console.warn("Tally returned no loaded companies. Open each company that should be mirrored in TallyPrime.");
  else console.info(`Discovered ${names.length} loaded Tally company(ies): ${names.join(", ")}.`);
  return records.length;
}

function getLoadedCompany(guid) {
  const key = companyKey(guid);
  if (!loadedCompanyGuids.has(key)) return null;
  return companies.get(key) || null;
}

const requestWorker = new RequestWorker({
  api,
  tally,
  getCompanyContext: getLoadedCompany,
  activateCompany,
  resultPartBytes: config.resultPartBytes,
});

let active = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function pollLoadedCompanies() {
  if (config.enableQueryQueue && loadedCompanyGuids.size) {
    const count = await requestWorker.pollOnce();
    if (count) console.info(`Processed ${count} queued read-only export request(s).`);
  }

  for (const key of loadedCompanyGuids) {
    const context = companies.get(key);
    if (!context) continue;
    activateCompany(context);
    try {
      if (config.enableDataSync) {
        const kind = await context.syncWorker.pollOnce();
        if (kind) console.info(`Processed a Tally ${kind} sync window for ${context.companyName}.`);
      }
      if (config.enableDeletionSweeps) {
        context.sweepWorker.companyBooksFrom = maxDate(context.companyBooksFrom, config.voucherPeriodFrom);
        const initialComplete = syncKinds.every((kind) => context.syncWorker.initialSyncComplete[kind] === true);
        if (initialComplete) {
          const kind = await context.sweepWorker.pollOnce();
          if (kind) console.info(`Finished Tally ${kind} deletion sweep for ${context.companyName}.`);
        } else {
          console.info(`Deferring deletion sweep for ${context.companyName} until every initial mirror load is complete.`);
        }
      }
    } catch (error) {
      console.error(`Connector poll failed for ${context.companyName} (${context.companyGuid}): ${error.message}`);
      if (error.status === 429) throw error;
    }
  }
}

async function run() {
  console.info("Tally connector starting in multi-company discovery mode.");
  console.info(`Voucher start date: ${config.voucherPeriodFrom}.`);
  console.info(`Features: sync=${config.enableDataSync}, readOnlyQueryQueue=${config.enableQueryQueue}, deletionSweeps=${config.enableDeletionSweeps}.`);
  try {
    const health = await api.health();
    console.info(`tallyApi health check: ${health?.ok === false ? "reported not ready" : "reachable"}.`);
  } catch (error) {
    console.error(`tallyApi health check failed: ${error.message}`);
  }

  while (!stopping) {
    if (!active && Date.now() >= waitUntil) {
      active = true;
      try {
        await discoverLoadedCompanies();
        await pollLoadedCompanies();
      } catch (error) {
        console.error(`Connector poll failed: ${error.message}`);
        if (error.status === 429) {
          waitUntil = nextDhakaMidnight();
          console.error(`APE's daily safety limit is reached; pausing until ${new Date(waitUntil).toISOString()} (midnight Asia/Dhaka).`);
        }
      } finally {
        active = false;
      }
    }
    await sleep(config.pollMs);
  }
  console.info("Tally connector stopped.");
}

function nextDhakaMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  // Dhaka is UTC+06:00; convert the next local calendar midnight to UTC.
  return Date.UTC(fields.year, fields.month - 1, fields.day + 1) - 6 * 60 * 60 * 1000;
}

run().catch((error) => {
  console.error(`Connector could not start: ${error.message}`);
  process.exitCode = 1;
});
