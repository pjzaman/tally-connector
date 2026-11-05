# TallyPrime local connector

This is the local Windows-side starting point for the revised connector contract. It makes outbound HTTPS calls to APE's `tallyApi` and sends queued, read-only XML exports to Tally at `127.0.0.1:9000`. It does not open a port or write data into Tally.

## Current milestone

The connector contains the API client, local Tally XML transport, owner-request queue, per-kind initial sync, cursor-driven incremental sync, and staged GUID sweeps. Initial loads are confirmed per kind only after every batch is accepted; normal cursor progress comes from `/ingest`. Sweeps carry a per-kind AlterID watermark and can recover missing pages or retry finalization. The Tally collection and aggregation XML still needs to be checked against this installation's TallyPrime 1.1.4.1 before live sync is enabled.

## Setup

1. Install Node.js 22 or newer and Git.
2. Clone this repository (`git clone https://github.com/pjzaman/tally-connector.git`), then run `npm ci` and `npm test` in it. The tests are offline: they make no network calls and contact neither Tally nor APE.
3. Copy `.env.example` to `.env` and fill in `COMPANY_GUID` and `COMPANY_NAME`. Put the API key in Windows Credential Manager as a Generic Credential named `APE_TALLY_CONNECTOR_KEY`; the connector reads it without printing it. Alternatively, set the `APE_TALLY_CONNECTOR_KEY` environment variable. `.env` is only a local development option and is ignored by Git. If Tally does not return the company's earliest books date, set `COMPANY_BOOKS_FROM` so the full-history voucher sweeper can run.

   Voucher reads always send an explicit date period (`SVFROMDATE`/`SVTODATE`), from `VOUCHER_PERIOD_FROM` (default: the company's BooksFrom, else 2000-01-01) to the end of next year. Without it, Tally uses whatever period is selected in its window, and changes to vouchers outside that period are missed. Widening the period does not re-import old vouchers: after the initial load, only records with an AlterID above the saved cursor are read.
4. Start TallyPrime with the intended company open and the XML server enabled on port 9000.
5. Run `npm start`. Query queue, data sync, and deletion sweeps all default to disabled. Enable each with its `ENABLE_*` setting only after the API endpoints and Tally XML have been validated.

The connector checks the active Tally company's GUID and name before each export. Queued requests must contain exactly one `TALLYREQUEST=Export`; imports, request-data operations, mutating actions, and inline TDL function definitions are rejected. Other read-only export types remain available so an authorized owner can request the export they need.

## Offline safety review

Run `npm run dry-run` to print the connector's generated Tally XML request templates for review. This command makes no network connections and sends nothing to Tally or APE. It checks that each built-in request has exactly one `TALLYREQUEST=Export` and no known write-operation markers. Set `DRY_RUN_DATE=YYYY-MM-DD` to choose the sample date for voucher sweep ranges. Queued owner reports arrive from APE at runtime; the connector parses and validates each one before sending it to Tally.

After reviewing the templates, `npm run verify-tally` sends exactly one read-only company-information Export to the local Tally address. It makes no API calls and starts no sync or sweep. Set `COMPANY_NAME` to the exact open company name; if `COMPANY_GUID` is set, the command checks that too. It refuses non-local Tally addresses.

Run `npm run verify-exports` to check the watermark and a five-AlterID sample export for each data kind. It verifies the active company before each export, prints only record counts, and does not contact APE. Run this before enabling data sync.

## Start automatically on Windows sign-in

Run `install-autostart.ps1` once from PowerShell under the same Windows account that owns the `APE_TALLY_CONNECTOR_KEY` Generic Credential. It registers a hidden Task Scheduler task for that account's next sign-in. The task starts mirror sync and the read-only query queue, keeps deletion sweeps off, retries startup failures, and writes output to `logs/connector.log` (rotating the prior log at 10 MB). The task waits for the local Tally process by retrying startup if Tally is not ready yet. To start or stop the scheduled task manually, use `Start-ScheduledTask -TaskName 'Tally Firestore Connector'` or `Stop-ScheduledTask -TaskName 'Tally Firestore Connector'`.

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
- If APE answers `429` (its daily safety limit is reached), the connector logs the reason and waits 15 minutes between attempts instead of retrying every poll.

## Tally release note

The installation inspected for this task reports TallyPrime file version 1.1.4.1. Verify every collection name, fetched method, AlterID filter, watermark query, and XML response shape against that release. Do not assume examples from newer TallyPrime releases work unchanged.
