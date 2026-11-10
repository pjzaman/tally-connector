"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

class ProgressStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
    this.writeNumber = 0;
  }

  async load() {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.state = parsed && parsed.version === 1 && parsed.companies && typeof parsed.companies === "object"
        ? parsed
        : { version: 1, companies: {} };
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`Could not read initial-sync checkpoint file: ${error.message}`);
      this.state = { version: 1, companies: {} };
    }
    return this.state;
  }

  async get(companyGuid, kind) {
    const state = await this.load();
    return state.companies[String(companyGuid).toLowerCase()]?.[kind] || null;
  }

  async set(companyGuid, kind, progress) {
    const state = await this.load();
    const key = String(companyGuid).toLowerCase();
    state.companies[key] ||= {};
    state.companies[key][kind] = {
      watermark: progress.watermark,
      cursor: progress.cursor,
      windowSize: progress.windowSize,
      savedAt: new Date().toISOString(),
    };
    await this.save();
  }

  async delete(companyGuid, kind) {
    const state = await this.load();
    const key = String(companyGuid).toLowerCase();
    if (!state.companies[key]) return;
    delete state.companies[key][kind];
    if (!Object.keys(state.companies[key]).length) delete state.companies[key];
    await this.save();
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${++this.writeNumber}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.state), { encoding: "utf8" });
    await fs.rename(tempPath, this.filePath);
  }
}

module.exports = { ProgressStore };
