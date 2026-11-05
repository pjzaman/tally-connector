"use strict";

const { kinds, buildCollectionRequest, rowsFromXml, watermarkFromXml, findValue, voucherPeriod } = require("./tally-collections");
const { version: connectorVersion } = require("../package.json");

const syncKinds = [...Object.keys(kinds).filter((kind) => !["company", "voucher", "voucherType"].includes(kind)), "voucherType", "voucher"];
const maxAlterIdWindow = 5_000;
const maxBatchRecords = 200;
const maxBatchBytes = 4_300_000;

function buildBatches(records) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const record of records) {
    const itemBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (itemBytes > maxBatchBytes) throw new Error(`Record ${record.guid} is too large after raw payload trimming.`);
    if (current.length && (current.length >= maxBatchRecords || bytes + itemBytes > maxBatchBytes)) {
      batches.push(current); current = []; bytes = 0;
    }
    current.push(record); bytes += itemBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return text;
  match = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/.exec(text);
  if (match) {
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].findIndex((name) => name.toLowerCase() === match[2].toLowerCase()) + 1;
    if (month) return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  }
  match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  if (match) return `${match[3]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  return null;
}

class SyncWorker {
  constructor({ api, tally, companyGuid, companyName, companyBooksFrom = null, voucherPeriodFrom = null }) {
    Object.assign(this, { api, tally, companyGuid, companyName });
    this.companyBooksFrom = companyBooksFrom ? normalizeDate(companyBooksFrom) : null;
    this.voucherPeriodFrom = voucherPeriodFrom ? normalizeDate(voucherPeriodFrom) : null;
    this.cursors = {};
    this.initialSyncComplete = {};
    this.lastStarted = new Map();
    this.voucherTypes = {};
    this.voucherTypesLoaded = false;
    this.pendingRanges = new Map();
    this.cursorLoaded = false;
    this.companyVerified = false;
    this.initialSyncLogged = false;
  }

  async loadCursors() {
    const result = await this.api.cursor(this.companyGuid);
    this.cursors = result?.cursors && typeof result.cursors === "object" ? result.cursors : {};
    this.initialSyncComplete = result?.initialSyncComplete && typeof result.initialSyncComplete === "object" ? result.initialSyncComplete : {};
  }

  async initialize({ enableSync = true } = {}) {
    await this.verifyCompany();
    if (enableSync && !this.cursorLoaded) {
      await this.loadCursors();
      this.cursorLoaded = true;
    }
    if (enableSync && !this.voucherTypesLoaded) await this.loadVoucherTypes();
  }

  // Vouchers need every voucher type's parent and reserved name to work out their base type, so
  // read them all from Tally at start-up instead of relying on voucher-type changes seen this run.
  async loadVoucherTypes() {
    const xml = buildCollectionRequest({ kind: "voucherType", companyName: this.companyName });
    this.rememberVoucherTypes(rowsFromXml(await this.tally.exportXml(xml), "voucherType"));
    this.voucherTypesLoaded = true;
  }

  rememberVoucherTypes(records) {
    for (const row of records) {
      if (row.summary?.name) this.voucherTypes[row.summary.name] = { parent: row.summary.parent, reservedName: row.summary.reservedName };
    }
  }

  period(kind) {
    return kind === "voucher" ? voucherPeriod(this.voucherPeriodFrom || this.companyBooksFrom) : {};
  }

  async verifyCompany(force = false) {
    if (this.companyVerified && !force) return;
    const xml = buildCollectionRequest({ kind: "company", companyName: null });
    const response = await this.tally.exportXml(xml, { skipCompanyVerification: true });
    const records = rowsFromXml(response, "company");
    const match = records.find((row) => row.guid === this.companyGuid && row.summary.name === this.companyName);
    if (!match) throw new Error("Configured company GUID/name did not match a company returned by Tally. No sync data was sent.");
    this.companyBooksFrom = this.companyBooksFrom || normalizeDate(findValue(match.raw, ["BooksFrom", "StartingFrom"]));
    this.companyVerified = true;
  }

  async pollOnce() {
    await this.initialize();
    const now = Date.now();
    const pending = syncKinds.find((kind) => this.pendingRanges.has(kind));
    if (pending) {
      while (this.pendingRanges.has(pending)) await this.processNextRange(pending);
      return pending;
    }
    const initial = syncKinds.find((kind) => this.initialSyncComplete[kind] !== true);
    if (initial) {
      await this.beginKind(initial);
      while (this.pendingRanges.has(initial)) await this.processNextRange(initial);
      return initial;
    }
    if (!this.initialSyncLogged) {
      console.info("Initial mirror load is complete for every Tally kind.");
      this.initialSyncLogged = true;
    }
    const due = syncKinds.find((kind) => now - (this.lastStarted.get(kind) || 0) >= kinds[kind].intervalMs);
    if (!due) return null;
    this.lastStarted.set(due, now);
    const sent = await this.beginKind(due);
    return sent > 0 ? due : null;
  }

  async readWatermark(kind) {
    const xml = buildCollectionRequest({ kind, companyName: this.companyName, watermark: true, ...this.period(kind) });
    return watermarkFromXml(await this.tally.exportXml(xml), kind);
  }

  async readRange(kind, low, high = null) {
    const xml = buildCollectionRequest({ kind, companyName: this.companyName, minAlterId: low, maxAlterId: high, ...this.period(kind) });
    return rowsFromXml(await this.tally.exportXml(xml), kind, this.voucherTypes)
      .filter((record) => record.alterId > low && (high == null || record.alterId <= high))
      .sort((a, b) => a.alterId - b.alterId);
  }

  async beginKind(kind) {
    const isInitial = this.initialSyncComplete[kind] !== true;
    if (isInitial) {
      const watermark = await this.readWatermark(kind);
      this.pendingRanges.set(kind, { initial: true, watermark, cursor: -1 });
      return;
    }
    const cursor = Number(this.cursors[kind] || 0);
    const records = await this.readRange(kind, cursor);
    return this.sendRecords(kind, records, false);
  }

  async sendRecords(kind, records, initialSync) {
    if (kind === "voucherType") this.rememberVoucherTypes(records);
    const batches = buildBatches(records);
    for (const batch of batches) {
      const result = await this.api.ingest({
        companyGuid: this.companyGuid,
        companyName: this.companyName,
        connectorVersion,
        initialSync,
        records: batch,
      });
      if (!initialSync) {
        const advanced = Number(result?.cursors?.[kind]);
        const batchMax = batch.reduce((max, record) => Math.max(max, record.alterId), Number(this.cursors[kind] || 0));
        this.cursors[kind] = Number.isSafeInteger(advanced) && advanced >= 0 ? advanced : batchMax;
      }
    }
    return records.length;
  }

  async processNextRange(kind) {
    const pending = this.pendingRanges.get(kind);
    if (!pending) return;
    const low = pending.cursor;
    const high = Math.min(low + maxAlterIdWindow, pending.watermark);
    const records = high > low ? await this.readRange(kind, low, high) : [];
    await this.sendRecords(kind, records, true);
    pending.cursor = high;
    if (pending.cursor >= pending.watermark) {
      await this.api.saveCursor({ companyGuid: this.companyGuid, kind, alterId: pending.watermark, initialSyncComplete: true });
      this.cursors[kind] = pending.watermark;
      this.initialSyncComplete[kind] = true;
      this.pendingRanges.delete(kind);
      console.info(`Initial Tally ${kind} load confirmed at AlterID ${pending.watermark}.`);
    }
  }
}

module.exports = { SyncWorker, syncKinds, buildBatches, normalizeDate };
