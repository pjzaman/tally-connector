# APE `tallyApi` follow-up for connector 0.2.1

The Tally-side connector now sends records only to the documented mirror endpoints. The deployed API implementation is not in this repository, so these server-side items need to be implemented and confirmed by the APE backend owner.

## Required mirror status fields

- On accepted `/ingest`, update `tallyCompanies/<companyGuid>.connectorVersion` from the request and set `lastPushAt` to server time.
- On successfully finalized `/sweep`, set `lastSweepAt` to server time.
- Add an authenticated, company-scoped status update (or equivalent server-managed behavior) that records `lastError: { message, at }` on `tallyCompanies/<companyGuid>` when an ingest, sweep, or query operation fails, and clears it after a later successful operation. Validate the GUID and limit/sanitize message length. Do not allow writes to APE ERP collections.
- Publish the endpoint contract and authorization requirements before the connector calls it. The current client contract in this repo has no status endpoint, so connector 0.2.1 does not guess one.

## Daily write limit and stalled initial loads

The Tally PC log reported HTTP 429 after 20,038 records had been written against a stated 20,000-record daily limit. Confirm whether that limit counts documents, accepted records, or requests; make enforcement atomic so concurrent calls cannot exceed the configured limit. Then either raise the limit to a practical backfill allowance or confirm that a daily pause is expected. Connector 0.2.1 checkpoints accepted initial-load windows locally and pauses until midnight Asia/Dhaka after 429.

## Query queue recovery

The connector parser now defines and imports `scalar`, fixing the reported local `"scalar is not defined"` failure. Please requeue or reset the already-failed request documents `LBjcT2ExlnfxZDsgV0OR` and `rvrDxMaMyuNzMBvOir2S` (or provide a supported retry action); connector polling should not silently rewrite terminal server request status.

## Checks APE should report

For each GUID in the 10 Nov brief, report non-deleted 2026 voucher count and latest voucher date from the mirror, `initialSyncComplete.voucher`, `lastPushAt`, and `lastSweepAt`; compare count/date to read-only Tally exports for 2026-01-01 through today. Confirm the October sales and November purchases. Re-run a Company collection query and confirm it reaches `status: "done"` with all loaded companies in result chunks.

The requested create/edit/delete voucher acceptance check changes Tally's source records. Do not perform it unless the owner explicitly approves a designated test voucher and its cleanup; it is outside connector implementation.
