"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

function enabled(name) {
  return String(process.env[name] || "false").toLowerCase() === "true";
}

function connectorApiKey() {
  const direct = process.env.APE_TALLY_CONNECTOR_KEY?.trim() || process.env.TALLY_API_KEY?.trim();
  if (direct) return direct;
  if (process.platform === "win32") {
    try {
      const key = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "read-credential.ps1"),
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (key) return key;
    } catch { /* Fall through to the clear missing-key message. */ }
  }
  return required("APE_TALLY_CONNECTOR_KEY");
}

const config = {
  apiUrl: new URL(process.env.TALLY_API_URL?.trim() || "https://us-central1-ape-erp-508ee.cloudfunctions.net/tallyApi"),
  apiKey: connectorApiKey(),
  tallyUrl: new URL(process.env.TALLY_URL || "http://127.0.0.1:9000"),
  companyGuid: required("COMPANY_GUID"),
  companyName: required("COMPANY_NAME"),
  companyBooksFrom: process.env.COMPANY_BOOKS_FROM?.trim() || null,
  // Earliest voucher date the sync watches for changes. Defaults to the company's BooksFrom date.
  voucherPeriodFrom: process.env.VOUCHER_PERIOD_FROM?.trim() || null,
  pollMs: Math.max(10, Number(process.env.POLL_SECONDS || 45)) * 1000,
  resultPartBytes: Math.min(2_200_000, Math.max(100_000, Number(process.env.REQUEST_RESULT_PART_BYTES || 2_000_000))),
  timeoutMs: Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 30_000)),
  enableQueryQueue: enabled("ENABLE_QUERY_QUEUE"),
  enableDataSync: enabled("ENABLE_DATA_SYNC"),
  enableDeletionSweeps: enabled("ENABLE_DELETION_SWEEPS"),
};

if (!Number.isFinite(config.pollMs) || !Number.isFinite(config.resultPartBytes) || !Number.isFinite(config.timeoutMs)) {
  throw new Error("POLL_SECONDS, REQUEST_RESULT_PART_BYTES, and REQUEST_TIMEOUT_MS must be numbers.");
}

if (config.apiUrl.protocol !== "https:") {
  throw new Error("TALLY_API_URL must use HTTPS.");
}

if (config.tallyUrl.hostname !== "127.0.0.1" && config.tallyUrl.hostname !== "localhost") {
  console.warn("TALLY_URL is not loopback. Keep the Tally XML port on the trusted LAN and firewall it from the internet.");
}

module.exports = config;
