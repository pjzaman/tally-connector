"use strict";

const { randomUUID } = require("node:crypto");
const { kinds, buildCollectionRequest, guidsFromXml, watermarkFromXml } = require("./tally-collections");

const pageSize = 10_000;
const masterKinds = Object.keys(kinds).filter((kind) => kind !== "company" && kind !== "voucher");

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function dhakaNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { fromDate: start, toDate: `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}` };
}

function recentMonthRanges(today) {
  const [year, month] = today.split("-").slice(0, 2).map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const currentRange = monthRange(year, month);
  currentRange.toDate = today;
  return [
    monthRange(previous.getUTCFullYear(), previous.getUTCMonth() + 1),
    currentRange,
  ];
}

function monthsBetween(fromDate, throughDate) {
  const [fromYear, fromMonth] = fromDate.split("-").map(Number);
  const [toYear, toMonth] = throughDate.split("-").map(Number);
  const ranges = [];
  for (let year = fromYear, month = fromMonth; year < toYear || (year === toYear && month <= toMonth); ) {
    ranges.push(monthRange(year, month));
    month++;
    if (month === 13) { month = 1; year++; }
  }
  if (ranges.length) {
    ranges[ranges.length - 1].toDate = throughDate;
    ranges[0].fromDate = fromDate;
  }
  return ranges;
}

function paginate(items, size) {
  const pages = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages.length ? pages : [[]];
}

class SweepWorker {
  constructor({ api, tally, companyGuid, companyName, companyBooksFrom, voucherPeriodFrom = "2026-01-01" }) {
    const minimum = "2026-01-01";
    Object.assign(this, {
      api, tally, companyGuid, companyName, companyBooksFrom,
      voucherPeriodFrom: typeof voucherPeriodFrom === "string" && voucherPeriodFrom >= minimum ? voucherPeriodFrom : minimum,
    });
    this.queue = [];
    this.queuedKeys = new Set();
    this.lastDailyDay = "";
    this.lastRecentHour = "";
  }

  enqueue(task, priority = false) {
    const key = task.fromDate ? `${task.kind}:${task.fromDate}:${task.toDate}` : `${task.kind}:all`;
    if (this.queuedKeys.has(key)) return;
    const entry = { ...task, key, attempts: 0, readyAt: 0 };
    if (priority) this.queue.unshift(entry); else this.queue.push(entry);
    this.queuedKeys.add(key);
  }

  schedule(now = dhakaNow()) {
    const today = `${now.year}-${now.month}-${now.day}`;
    const hour = `${today}T${now.hour}`;
    if (this.lastRecentHour !== hour) {
      const ranges = recentMonthRanges(today);
      for (const range of ranges) {
        if (this.voucherPeriodFrom && range.toDate < this.voucherPeriodFrom) continue;
        if (this.voucherPeriodFrom && range.fromDate < this.voucherPeriodFrom) range.fromDate = this.voucherPeriodFrom;
        this.enqueue({ kind: "voucher", ...range }, true);
      }
      this.lastRecentHour = hour;
    }
    if (this.lastDailyDay !== today) {
      const booksFrom = [this.companyBooksFrom, this.voucherPeriodFrom].filter(Boolean).sort().at(-1);
      if (booksFrom && booksFrom <= today) {
        for (const range of monthsBetween(booksFrom, today)) this.enqueue({ kind: "voucher", ...range });
      }
      for (const kind of masterKinds) this.enqueue({ kind });
      this.lastDailyDay = today;
    }
  }

  async pollOnce() {
    this.schedule();
    const index = this.queue.findIndex((task) => task.readyAt <= Date.now());
    if (index < 0) return null;
    const [task] = this.queue.splice(index, 1);
    this.queuedKeys.delete(task.key);
    try {
      await this.runSweep(task);
      return task.kind;
    } catch (error) {
      if (error.status === 429) throw error;
      task.attempts++;
      task.readyAt = Date.now() + Math.min(15 * 60_000, 30_000 * (2 ** Math.min(task.attempts, 5)));
      this.queue.push(task);
      this.queuedKeys.add(task.key);
      console.error(`Tally ${task.kind} sweep failed for ${this.companyName} (${this.companyGuid}); it will retry without finalizing deletion state: ${error.message}`);
      return null;
    }
  }

  async runSweep(task) {
    const watermarkXml = buildCollectionRequest({ kind: task.kind, companyName: this.companyName, watermark: true });
    const asOfAlterId = watermarkFromXml(await this.tally.exportXml(watermarkXml), task.kind);
    const xml = buildCollectionRequest({
      kind: task.kind,
      companyName: this.companyName,
      fromDate: task.fromDate,
      toDate: task.toDate,
      guidsOnly: true,
    });
    const response = await this.tally.exportXml(xml);
    const guids = [...new Set(guidsFromXml(response, task.kind))];
    const pages = paginate(guids, pageSize);
    const sweepId = randomUUID();
    const sendPart = (part) => this.api.sweep({
        companyGuid: this.companyGuid,
        kind: task.kind,
        ...(task.fromDate ? { fromDate: task.fromDate, toDate: task.toDate } : {}),
        sweepId,
        asOfAlterId,
        part,
        final: part === pages.length - 1,
        guids: pages[part],
      });
    let result;
    for (let part = 0; part < pages.length; part++) {
      result = await sendPart(part);
      if (result?.accepted !== true) throw new Error(`APE did not confirm sweep part ${part}.`);
    }
    for (let recovery = 0; recovery < 5; recovery++) {
      if (result?.finalized === true) break;
      if (Array.isArray(result?.missingParts) && result.missingParts.length) {
        for (const part of result.missingParts) {
          if (!Number.isSafeInteger(part) || part < 0 || part >= pages.length) throw new Error("APE requested an invalid missing sweep part.");
          result = await sendPart(part);
          if (result?.accepted !== true) throw new Error(`APE did not confirm sweep part ${part}.`);
        }
        result = await sendPart(pages.length - 1);
        continue;
      }
      if (result?.finalizing === true) {
        await delay(60_000);
        result = await sendPart(pages.length - 1);
        continue;
      }
      break;
    }
    if (result?.finalized !== true) throw new Error("APE did not confirm sweep finalization.");
    console.info(`Completed Tally ${task.kind} sweep (${guids.length} GUIDs${task.fromDate ? `, ${task.fromDate} to ${task.toDate}` : ""}).`);
  }
}

module.exports = { SweepWorker, monthsBetween, paginate, recentMonthRanges };
