# TallyPrime local connector

This is the local Windows-side connector for APE's `tallyApi`. It discovers every company currently loaded in TallyPrime, keeps a separate cursor per company GUID, and sends read-only XML exports to Tally at `127.0.0.1:9000`. It makes outbound HTTPS calls only and does not open a port or write data into Tally.

## Current milestone

The connector contains the API client, local Tally XML transport, owner-request queue, per-kind initial sync, cursor-driven incremental sync, and staged GUID sweeps. Initial loads are confirmed per kind only after every batch is accepted; normal cursor progress comes from `/ingest`. Sweeps carry a per-kind AlterID watermark and can recover missing pages or retry finalization. This version is configured for the already-running mirror sync; it does not write to Tally.

## Setup

1. Install Node.js 22 or newer and Git.
2. Clone this repository (`git clone https://github.com/pjzaman/tally-connector.git`), then run `npm ci` in it.
3. Copy `.env.example` to `.env` if local settings are needed. Put the API key in Windows Credential Manager as a Generic Credential named `APE_TALLY_CONNECTOR_KEY`; the connector reads it without printing it. Alternatively, set the `APE_TALLY_CONNECTOR_KEY` environment variable. `.env` is optional and ignored by Git. Keep every company intended for mirroring loaded in TallyPrime; the connector discovers loaded companies on each polling cycle.

   Voucher reads always send an explicit date period (`SVFROMDATE`/`SVTODATE`) from `VOUCHER_PERIOD_FROM` (default `2026-01-01`) to the end of next year. The date rule applies to voucher exports; master records are still needed to resolve voucher fields. Existing per-company cursors are preserved, so setting the cutoff does not re-import earlier vouchers. Without an explicit period Tally uses the period selected in its window, which can silently miss changes.
4. Start TallyPrime with every company to mirror loaded and the XML server enabled on port 9000.
5. The scheduled connector runner enables sync, read-only queries, and staged mirror deletion sweeps. Sweeps remain gated per company until every initial kind is confirmed complete. Sweeps update mirror deletion state only; the connector only sends read-only XML requests to Tally and never changes Tally records.

Before each company-specific export, the connector verifies that the target GUID and name are among the companies loaded in Tally. It sends each company's records with that company's `SVCURRENTCOMPANY`, and APE stores them under that GUID's `tallyCompanies/<companyGuid>` mirror. The connector does not call APE ERP write endpoints. Queued requests must contain exactly one `TALLYREQUEST=Export`; imports, request-data operations, mutating actions, and inline TDL function definitions are rejected. Queries without an explicit company are scoped to the request's company, except Company collection exports that intentionally list all loaded companies.

## Offline safety review

Run `npm run dry-run` to print the connector's generated Tally XML request templates for review. This command makes no network connections and sends nothing to Tally or APE. It checks that each built-in request has exactly one `TALLYREQUEST=Export` and no known write-operation markers. Set `DRY_RUN_DATE=YYYY-MM-DD` to choose the sample date for voucher sweep ranges. Queued owner reports arrive from APE at runtime; the connector parses and validates each one before sending it to Tally.

After reviewing the templates, `npm run verify-tally` sends exactly one read-only Company collection Export and lists loaded names, GUIDs, and BooksFrom values. It makes no API calls and starts no sync or sweep. If `COMPANY_NAME` or `COMPANY_GUID` is set, it checks that selection too. It refuses non-local Tally addresses.

Run `npm run verify-exports` to check all loaded companies, the watermark, and a five-AlterID sample export for each data kind. Set both `COMPANY_NAME` and `COMPANY_GUID` to limit the check to one company. It prints only record counts and does not contact APE.

## Start automatically on Windows sign-in

Run `install-autostart.ps1` once from PowerShell under the same Windows account that owns the `APE_TALLY_CONNECTOR_KEY` Generic Credential. It registers a hidden Task Scheduler task for that account's next sign-in. The task starts multi-company mirror sync, the read-only query queue, and staged mirror deletion sweeps after each company's initial load, retries startup failures, and writes output to `logs/connector.log` (rotating the prior log at 10 MB). Partial initial loads are checkpointed in `state/initial-sync-progress.json` so restarts can resume. On APE HTTP 429, it pauses until midnight Asia/Dhaka. The log remains readable while the connector runs. To start or stop the scheduled task manually, use `Start-ScheduledTask -TaskName 'Tally Firestore Connector'` or `Stop-ScheduledTask -TaskName 'Tally Firestore Connector'`.

## API expectations

The function URL and `X-Tally-Key` follow the current `TALLY_CONNECTOR.md` contract. `/cursor` reports per-kind cursors and initial-load completion; its POST confirms initial loads only. `/ingest` advances polling cursors. `/sweep` accepts numbered pages with `asOfAlterId`, and query results use numbered multipart uploads with missing-part recovery. These are implemented and deployed in APE's `tallyApi`.

## Updating the installed connector

Stop the task, pull, check, and start again:

```powershell
Stop-ScheduledTask -TaskName 'Tally Firestore Connector'
git pull
npm ci
npm test
npm run verify-exports
Start-ScheduledTask -TaskName 'Tally Firestore Connector'
```

If the folder moved (for example, the first time it is run from a clone), run `install-autostart.ps1` again from the new folder so the scheduled task points at it.

## Base voucher type

Each voucher's `baseVoucherType` is the built-in Tally type it belongs to (Sales, Purchase, Payment, ...). It is found by walking up the voucher type's parents to the first type with a `RESERVEDNAME`. In this company, the built-in Sales type was renamed "Sales (Old)" (its `RESERVEDNAME` is still "Sales"), and a new "Sales" type sits under it; both resolve to Sales. Tally's own `BASEVOUCHERTYPE` field on vouchers is a number and is not used. Voucher types are read from Tally at start-up, so this works after a restart.

## Changes in 0.1.1

- Queued queries no longer fail with `scalar is not defined`.
- The read-only check now inspects every repeated `TALLYREQUEST` and `ACTION` tag, not only the first one.
- `baseVoucherType` is resolved from reserved names (it was "0" on every voucher).
- Voucher reads send an explicit date period.
- `run-connector.ps1` writes a readable UTF-8 log with timestamps, and no longer logs a false error when `.env` is absent.
- Connector 0.2.1 waits until midnight Asia/Dhaka after APE answers `429` for its daily safety limit.

## Multi-company operation

The current runner discovers companies loaded in TallyPrime on every polling cycle. For every loaded GUID, it uses APE's per-company cursor and sends records through the mirror API, which stores them under `tallyCompanies/<companyGuid>`. Opening an additional company makes it eligible for sync on the next discovery; closing one pauses its sync. Initial loads resume from the server's per-company cursor/confirmation state and a local checkpoint for partially accepted windows.

Voucher sync and any enabled voucher sweep are bounded to 2026-01-01 or later. `VOUCHER_PERIOD_FROM` may move the cutoff later; earlier values are clamped to 2026-01-01. The scheduled runner enables staged deletion sweeps after that company's initial load is complete. The connector calls the mirror API endpoints only and never writes to APE's ERP collections or to Tally.

## Changes in 0.2.0

- Discovers all currently loaded companies and maintains independent workers and cursors per GUID.
- Routes queued read-only queries to the request's company; leaves requests queued while their company is not loaded.
- Scopes company-specific queries to their requested company and allows Company collection queries to list loaded companies.
- Enforces the voucher cutoff of 2026-01-01 or later in sync and sweep code.
- Fixes company verification to parse Company collection records that do not contain AlterID.
- Processes initial-load windows fairly across loaded companies.

## Changes in 0.2.1

- Discovers loaded Tally companies on each polling cycle.
- Saves per-company, per-kind initial-load checkpoints locally; adapts to slow or malformed Tally export windows and splits oversized API batches. A single rejected oversized voucher is logged and skipped so the initial load can continue.
- Gives Tally XML exports a separate 120-second default timeout.
- Pauses at APE's daily 429 limit until midnight Asia/Dhaka instead of retrying every 15 minutes.
- Defers staged mirror deletion sweeps until all initial kinds for that company are confirmed complete; a 429 during a sweep reaches the daily pause handler.
- Keeps all Tally interaction read-only. Sweep requests only update the APE mirror.

## Tally release note

The installation inspected for this task reports TallyPrime file version 1.1.4.1. Verify every collection name, fetched method, AlterID filter, watermark query, and XML response shape against that release. Do not assume examples from newer TallyPrime releases work unchanged.
