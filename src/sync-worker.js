"use strict";

const { kinds, buildCollectionRequest, rowsFromXml, companiesFromXml, watermarkFromXml, voucherPeriod } = require("./tally-collections");
const { version: connectorVersion } = require("../package.json");

const syncKinds = [...Object.keys(kinds).filter((kind) => !["company", "voucher", "voucherType"].includes(kind)), "voucherType", "voucher"];
const maxAlterIdWindow = 1_000;
const maxBatchRecords = 200;
const maxBatchBytes = 4_300_000;

function buildBatches(records) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const record of records) {
    const itemBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (itemBytes > maxBatchBytes) {
      if (current.length) { batches.push(current); current = []; bytes = 0; }
      batches.push([record]);
      continue;
    }
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
  constructor({ api, tally, companyGuid, companyName, companyBooksFrom = null, voucherPeriodFrom = null, progressStore = null }) {
    Object.assign(this, { api, tally, companyGuid, companyName });
    this.progressStore = progressStore;
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
    if (!this.progressStore) return;
    for (const kind of syncKinds) {
      if (this.initialSyncComplete[kind] === true) {
        await this.progressStore.delete(this.companyGuid, kind);
        continue;
      }
      const saved = await this.progressStore.get(this.companyGuid, kind);
      if (!saved || !Number.isSafeInteger(saved.watermark) || !Number.isSafeInteger(saved.cursor)
        || saved.watermark < 0 || saved.cursor < -1 || saved.cursor > saved.watermark) continue;
      const windowSize = Number.isSafeInteger(saved.windowSize) && saved.windowSize > 0
        ? Math.min(maxAlterIdWindow, saved.windowSize)
        : maxAlterIdWindow;
      this.pendingRanges.set(kind, { initial: true, watermark: saved.watermark, cursor: saved.cursor, windowSize });
      console.info(`Resuming ${this.companyName} ${kind} initial load after AlterID ${saved.cursor} of ${saved.watermark}.`);
    }
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
    if (kind !== "voucher") return {};
    const fromDate = [this.voucherPeriodFrom, this.companyBooksFrom].filter(Boolean).sort().at(-1);
    return voucherPeriod(fromDate);
  }

  async verifyCompany(force = false) {
    if (this.companyVerified && !force) return;
    const xml = buildCollectionRequest({ kind: "company", companyName: null });
    const response = await this.tally.exportXml(xml, { skipCompanyVerification: true });
    const records = companiesFromXml(response);
    const match = records.find((row) => row.guid.toLowerCase() === this.companyGuid.toLowerCase() && row.summary.name === this.companyName);
    if (!match) throw new Error("Configured company GUID/name did not match a company returned by Tally. No sync data was sent.");
    this.companyBooksFrom = this.companyBooksFrom || normalizeDate(match.summary.booksFrom || match.summary.startingFrom);
    this.companyVerified = true;
  }

  async pollOnce() {
    await this.initialize();
    const now = Date.now();
    const pending = syncKinds.find((kind) => this.pendingRanges.has(kind));
    if (pending) {
      await this.processNextRange(pending);
      return pending;
    }
    const initial = syncKinds.find((kind) => this.initialSyncComplete[kind] !== true);
    if (initial) {
      await this.beginKind(initial);
      await this.processNextRange(initial);
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
      const pending = { initial: true, watermark, cursor: -1, windowSize: maxAlterIdWindow };
      this.pendingRanges.set(kind, pending);
      await this.saveProgress(kind, pending);
      return;
    }
    const cursor = Number(this.cursors[kind] || 0);
    if (kind === "voucher") {
      const watermark = await this.readWatermark(kind);
      const records = await this.readRange(kind, cursor);
      console.info(`Voucher poll for ${this.companyName}: cursor ${cursor}, Tally watermark ${watermark}, exported ${records.length} newer voucher(s).`);
      return this.sendRecords(kind, records, false);
    }
    const records = await this.readRange(kind, cursor);
    return this.sendRecords(kind, records, false);
  }

  async sendRecords(kind, records, initialSync) {
    if (kind === "voucherType") this.rememberVoucherTypes(records);
    const batches = buildBatches(records);
    for (const batch of batches) await this.sendBatch(kind, batch, initialSync);
    return records.length;
  }

  async sendBatch(kind, batch, initialSync) {
    try {
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
      } else {
        const pending = this.pendingRanges.get(kind);
        if (pending && batch.length) {
          pending.cursor = Math.max(pending.cursor, batch.reduce((max, record) => Math.max(max, record.alterId), pending.cursor));
          await this.saveProgress(kind, pending);
        }
      }
    } catch (error) {
      if (!isPayloadLimitError(error)) throw error;
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        console.warn(`tallyApi rejected a ${kind} batch for ${this.companyName} as too large; retrying it in smaller pieces.`);
        await this.sendBatch(kind, batch.slice(0, middle), initialSync);
        await this.sendBatch(kind, batch.slice(middle), initialSync);
        return;
      }
      if (initialSync && kind === "voucher" && batch.length === 1) {
        const record = batch[0];
        console.error(`Skipping oversized voucher for ${this.companyName}: GUID ${record.guid}, AlterID ${record.alterId}; tallyApi rejected the single-record document as too large.`);
        const pending = this.pendingRanges.get(kind);
        if (pending) {
          pending.cursor = Math.max(pending.cursor, record.alterId);
          await this.saveProgress(kind, pending);
        }
        return;
      }
      throw error;
    }
  }

  async processNextRange(kind) {
    const pending = this.pendingRanges.get(kind);
    if (!pending) return;
    const low = pending.cursor;
    const windowSize = pending.windowSize || maxAlterIdWindow;
    const high = Math.min(low + windowSize, pending.watermark);
    let records;
    try {
      records = high > low ? await this.readRange(kind, low, high) : [];
    } catch (error) {
      if (isSplittableTallyReadError(error) && high - low > 1) {
        pending.windowSize = Math.max(1, Math.floor((high - low) / 2));
        console.warn(`Tally ${kind} export for ${this.companyName} AlterIDs ${low + 1}-${high} failed (${error.message}); retrying smaller windows of ${pending.windowSize}.`);
        await this.saveProgress(kind, pending);
        return;
      }
      if (kind === "voucher" && high - low === 1 && isMalformedTallyExport(error)) {
        console.error(`Skipping unreadable voucher for ${this.companyName} at AlterID ${high}: ${error.message}`);
        pending.cursor = high;
        await this.saveProgress(kind, pending);
        await this.finishInitialRange(kind, pending);
        return;
      }
      throw error;
    }
    await this.sendRecords(kind, records, true);
    pending.cursor = high;
    pending.windowSize = Math.min(maxAlterIdWindow, Math.max(1, windowSize * 2));
    await this.saveProgress(kind, pending);
    await this.finishInitialRange(kind, pending);
  }

  async saveProgress(kind, pending) {
    if (this.progressStore) await this.progressStore.set(this.companyGuid, kind, pending);
  }

  async finishInitialRange(kind, pending) {
    if (pending.cursor >= pending.watermark) {
      await this.api.saveCursor({ companyGuid: this.companyGuid, kind, alterId: pending.watermark, initialSyncComplete: true });
      this.cursors[kind] = pending.watermark;
      this.initialSyncComplete[kind] = true;
      this.pendingRanges.delete(kind);
      if (this.progressStore) await this.progressStore.delete(this.companyGuid, kind);
      console.info(`Initial Tally ${kind} load confirmed at AlterID ${pending.watermark}.`);
    }
  }
}

function isPayloadLimitError(error) {
  return error?.status === 413 || /request body too large|payload too large|document.{0,20}(too large|size)|1\s?mib|exceeds.{0,30}(size|limit)|maximum.{0,30}size/i.test(error?.message || "");
}

function isSplittableTallyReadError(error) {
  return error?.source === "tally" && (error.name === "AbortError" || error.name === "TimeoutError")
    || isMalformedTallyExport(error);
}

function isMalformedTallyExport(error) {
  return /Tally returned malformed XML|Tally reported an export error|Tally rejected the XML export request/i.test(error?.message || "");
}

module.exports = { SyncWorker, syncKinds, buildBatches, normalizeDate };
