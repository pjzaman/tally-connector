"use strict";

// Offline tests: no network, no Tally, no APE API. Record data below is made up.
const test = require("node:test");
const assert = require("node:assert/strict");

const { validateReadOnlyExport, splitUtf8 } = require("../src/read-only-query");
const {
  buildCollectionRequest, rowsFromXml, resolveBaseVoucherType, voucherPeriod,
} = require("../src/tally-collections");
const { SyncWorker } = require("../src/sync-worker");
const { RequestWorker } = require("../src/request-worker");

const companyQuery = `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ApeCompanyInfo</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="ApeCompanyInfo"><TYPE>Company</TYPE>
    <NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>BooksFrom</NATIVEMETHOD>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;

const datedQuery = `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ApeOldVouchers</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>19900101</SVFROMDATE><SVTODATE>20251231</SVTODATE></STATICVARIABLES>
  <TDL><TDLMESSAGE><COLLECTION NAME="ApeOldVouchers"><TYPE>Voucher</TYPE><NATIVEMETHOD>Date</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;

test("read-only check accepts the export queries that used to crash with 'scalar is not defined'", () => {
  assert.deepEqual(validateReadOnlyExport(companyQuery), { companyName: null });
  assert.deepEqual(validateReadOnlyExport(datedQuery), { companyName: null });
  const named = companyQuery.replace("<SVEXPORTFORMAT>", "<SVCURRENTCOMPANY>Demo Co</SVCURRENTCOMPANY><SVEXPORTFORMAT>");
  assert.equal(validateReadOnlyExport(named).companyName, "Demo Co");
});

test("read-only check still rejects anything that could write to Tally", () => {
  const reject = (xml, pattern) => assert.throws(() => validateReadOnlyExport(xml), pattern);
  reject(companyQuery.replace(">Export<", ">Import<"), /exactly one TALLYREQUEST/);
  reject(companyQuery.replace("</HEADER>", "<TALLYREQUEST>Export</TALLYREQUEST></HEADER>"), /exactly one TALLYREQUEST/);
  reject(companyQuery.replace("</HEADER>", "<TALLYREQUEST>Import</TALLYREQUEST></HEADER>"), /exactly one TALLYREQUEST/);
  reject(companyQuery.replace("<TDLMESSAGE>", "<TDLMESSAGE><X><ACTION>Export</ACTION><ACTION>Alter</ACTION></X>"), /mutating action/);
  reject(companyQuery.replace("<BODY>", "<BODY><IMPORTDATA></IMPORTDATA>"), /IMPORTDATA/);
  reject(companyQuery.replace("<TDLMESSAGE>", "<TDLMESSAGE><FUNCTION NAME=\"X\"></FUNCTION>"), /TDL functions/);
  reject(companyQuery.replace("<TDLMESSAGE>", "<TDLMESSAGE><VOUCHER ACTION=\"Create\"></VOUCHER>"), /mutating action/);
  reject(companyQuery.replace("<TDLMESSAGE>", "<TDLMESSAGE><VOUCHER ACTION=' delete '></VOUCHER>"), /mutating action/);
  reject("<!DOCTYPE x><ENVELOPE/>", /DTD/);
  reject("<ENVELOPE><HEADER>", /malformed/);
});

test("splitUtf8 never cuts a multi-byte character", () => {
  const text = "৳".repeat(1000);
  const parts = splitUtf8(text, 1001);
  assert.equal(parts.join(""), text);
  for (const part of parts) assert.ok(!part.includes("�"));
});

// Same shape as this company: the built-in Sales type was renamed "Sales (Old)" (RESERVEDNAME
// stays "Sales") and a user-made "Sales" type sits under it.
const voucherTypes = {
  "Sales (Old)": { parent: "Sales (Old)", reservedName: "Sales" },
  Sales: { parent: "Sales (Old)", reservedName: "" },
  Payment: { parent: "Payment", reservedName: "Payment" },
  "Cash Sale": { parent: "Sales", reservedName: "" },
  Loop: { parent: "Loop2", reservedName: "" },
  Loop2: { parent: "Loop", reservedName: "" },
};

test("base voucher type comes from the built-in reserved name up the parent chain", () => {
  assert.equal(resolveBaseVoucherType("Sales (Old)", voucherTypes), "Sales");
  assert.equal(resolveBaseVoucherType("Sales", voucherTypes), "Sales");
  assert.equal(resolveBaseVoucherType("Cash Sale", voucherTypes), "Sales");
  assert.equal(resolveBaseVoucherType("Payment", voucherTypes), "Payment");
  assert.equal(resolveBaseVoucherType("Unknown", voucherTypes), null);
  assert.equal(resolveBaseVoucherType("Loop", voucherTypes), null);
});

function envelope(inner) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
}
const voucherTypeXml = envelope(`
  <VOUCHERTYPE NAME="Sales (Old)" RESERVEDNAME="Sales"><GUID TYPE="String">g-vt-1</GUID><PARENT TYPE="String">Sales (Old)</PARENT><ALTERID TYPE="Number">10</ALTERID><MASTERID TYPE="Number">1</MASTERID></VOUCHERTYPE>
  <VOUCHERTYPE NAME="Sales" RESERVEDNAME=""><GUID TYPE="String">g-vt-2</GUID><PARENT TYPE="String">Sales (Old)</PARENT><ALTERID TYPE="Number">11</ALTERID><MASTERID TYPE="Number">2</MASTERID></VOUCHERTYPE>`);
function voucherXml(alterId, type) {
  return envelope(`<VOUCHER REMOTEID="g-v-${alterId}" VCHTYPE="${type}"><GUID>g-v-${alterId}</GUID><ALTERID TYPE="Number">${alterId}</ALTERID><MASTERID TYPE="Number">${alterId}</MASTERID>
    <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><BASEVOUCHERTYPE TYPE="Number">0</BASEVOUCHERTYPE><DATE TYPE="Date">20261105</DATE>
    <VOUCHERNUMBER>7</VOUCHERNUMBER><PARTYLEDGERNAME>Demo Customer</PARTYLEDGERNAME><AMOUNT TYPE="Amount">-100.00</AMOUNT></VOUCHER>`);
}
const companyXml = envelope(`<COMPANY NAME="Demo Co"><GUID>company-guid</GUID><NAME>Demo Co</NAME><BOOKSFROM TYPE="Date">20190101</BOOKSFROM></COMPANY>`);

test("voucher-type records keep RESERVEDNAME and vouchers get the right base type", () => {
  const types = rowsFromXml(voucherTypeXml, "voucherType");
  assert.deepEqual(types.map((t) => [t.summary.name, t.summary.reservedName]), [["Sales (Old)", "Sales"], ["Sales", ""]]);
  const [voucher] = rowsFromXml(voucherXml(50, "Sales"), "voucher", voucherTypes);
  assert.equal(voucher.summary.baseVoucherType, "Sales");
  const [unknown] = rowsFromXml(voucherXml(51, "Mystery"), "voucher", voucherTypes);
  assert.equal(unknown.summary.baseVoucherType, "Mystery");
});

test("voucher reads carry an explicit period; masters and unbounded calls do not", () => {
  const period = { fromDate: "2019-01-01", toDate: "2027-12-31" };
  for (const options of [{ watermark: true }, { minAlterId: 5 }, { minAlterId: 5, maxAlterId: 9 }]) {
    const xml = buildCollectionRequest({ kind: "voucher", companyName: "Demo Co", ...options, ...period });
    assert.match(xml, /<SVFROMDATE TYPE="Date">1-Jan-2019<\/SVFROMDATE><SVTODATE TYPE="Date">31-Dec-2027<\/SVTODATE>/);
    assert.equal(validateReadOnlyExport(xml).companyName, "Demo Co");
  }
  assert.doesNotMatch(buildCollectionRequest({ kind: "voucher", companyName: "Demo Co", minAlterId: 5 }), /SVFROMDATE/);
  assert.doesNotMatch(buildCollectionRequest({ kind: "ledger", companyName: "Demo Co", minAlterId: 5 }), /SVFROMDATE/);
  assert.throws(() => buildCollectionRequest({ kind: "voucher", companyName: "Demo Co", minAlterId: 5, fromDate: "2019-01-01" }), /both fromDate and toDate/);
});

test("voucherPeriod defaults to 2000-01-01 and runs to the end of next year", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  assert.deepEqual(voucherPeriod("2019-04-01", now), { fromDate: "2019-04-01", toDate: "2027-12-31" });
  assert.deepEqual(voucherPeriod(null, now), { fromDate: "2000-01-01", toDate: "2027-12-31" });
  assert.deepEqual(voucherPeriod("not a date", now), { fromDate: "2000-01-01", toDate: "2027-12-31" });
});

function fakeTally(responses) {
  const sent = [];
  return {
    sent,
    async exportXml(xml) {
      sent.push(xml);
      const id = /<ID>([^<]+)<\/ID>/.exec(xml)[1];
      if (!(id in responses)) throw new Error(`unexpected request ${id}`);
      return typeof responses[id] === "function" ? responses[id](xml) : responses[id];
    },
  };
}

test("after a restart the sync still labels new sales 'Sales' and asks Tally for an explicit period", async () => {
  const tally = fakeTally({
    Codex_company: companyXml,
    Codex_voucherType: voucherTypeXml,
    Codex_voucher: voucherXml(101, "Sales"),
  });
  const ingested = [];
  const allDone = Object.fromEntries(["ledger", "group", "stockItem", "stockGroup", "stockCategory", "godown", "unit", "costCentre", "currency", "voucherType", "voucher"].map((k) => [k, true]));
  const api = {
    async cursor() { return { cursors: { voucher: 100 }, initialSyncComplete: allDone }; },
    async ingest(batch) { ingested.push(batch); return { cursors: { voucher: 101 } }; },
  };
  const worker = new SyncWorker({ api, tally, companyGuid: "company-guid", companyName: "Demo Co" });
  for (const kind of Object.keys(allDone)) if (kind !== "voucher") worker.lastStarted.set(kind, Date.now());

  assert.equal(await worker.pollOnce(), "voucher");
  assert.equal(worker.companyBooksFrom, "2019-01-01");
  assert.equal(ingested.length, 1);
  const [record] = ingested[0].records;
  assert.equal(ingested[0].initialSync, false);
  assert.equal(ingested[0].connectorVersion, require("../package.json").version);
  assert.equal(record.summary.baseVoucherType, "Sales");
  assert.equal(worker.cursors.voucher, 101);
  const voucherRequest = tally.sent.find((xml) => xml.includes("<ID>Codex_voucher</ID>"));
  assert.match(voucherRequest, /1-Jan-2019<\/SVFROMDATE>/);
  assert.match(voucherRequest, /\$AlterID &gt; 100/);
});

test("VOUCHER_PERIOD_FROM overrides BooksFrom for the watched period", async () => {
  const tally = fakeTally({ Codex_company: companyXml, Codex_voucherType: voucherTypeXml, Codex_voucher: envelope("") });
  const allDone = { voucher: true, voucherType: true };
  const api = { async cursor() { return { cursors: { voucher: 5 }, initialSyncComplete: allDone }; }, async ingest() { throw new Error("nothing to send"); } };
  const worker = new SyncWorker({ api, tally, companyGuid: "company-guid", companyName: "Demo Co", voucherPeriodFrom: "2026-01-01" });
  await worker.initialize();
  await worker.readRange("voucher", 5);
  assert.match(tally.sent.at(-1), /1-Jan-2026<\/SVFROMDATE>/);
});

test("a queued read-only query runs and its result is uploaded", async () => {
  const tally = fakeTally({ ApeCompanyInfo: "<ENVELOPE><BODY>ok</BODY></ENVELOPE>" });
  const posted = [];
  const api = {
    async requests() { return { requests: [{ id: "q1", companyGuid: "company-guid", requestedBy: "test", xml: companyQuery }] }; },
    async result(id, body) { posted.push({ id, ...body }); return { status: "done", missingParts: [] }; },
  };
  const worker = new RequestWorker({ api, tally, companyGuid: "company-guid", companyName: "Demo Co", resultPartBytes: 100_000 });
  assert.equal(await worker.pollOnce(), 1);
  assert.deepEqual(posted, [{ id: "q1", part: 0, final: true, ok: true, body: "<ENVELOPE><BODY>ok</BODY></ENVELOPE>" }]);
});

test("a query for another company or with an import is refused without touching Tally", async () => {
  const tally = fakeTally({});
  const posted = [];
  const api = {
    async requests() {
      return { requests: [
        { id: "q2", companyGuid: "other-company", xml: companyQuery },
        { id: "q3", companyGuid: "company-guid", xml: companyQuery.replace("<BODY>", "<BODY><IMPORTDATA></IMPORTDATA>") },
      ] };
    },
    async result(id, body) { posted.push({ id, ...body }); return {}; },
  };
  const worker = new RequestWorker({ api, tally, companyGuid: "company-guid", companyName: "Demo Co", resultPartBytes: 100_000 });
  const quiet = console.error; console.error = () => {};
  try { await worker.pollOnce(); } finally { console.error = quiet; }
  assert.equal(tally.sent.length, 0);
  assert.deepEqual(posted.map((p) => [p.id, p.ok, p.final]), [["q2", false, true], ["q3", false, true]]);
  assert.match(posted[0].error, /company does not match/);
  assert.match(posted[1].error, /IMPORTDATA/);
});

test("a 429 from tallyApi is not retried and carries the server's reason", async () => {
  const { ApiClient } = require("../src/api-client");
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "Daily safety limit reached: 20000 records written today (daily limit 20000)." }), { status: 429 });
  };
  try {
    const api = new ApiClient({ baseUrl: "https://example.invalid/tallyApi", apiKey: "test", timeoutMs: 1000 });
    await assert.rejects(api.cursor("company-guid"), (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /HTTP 429: Daily safety limit reached/);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    global.fetch = realFetch;
  }
});
