# Supplier Payments Management

A local React, TypeScript, Vite, Material UI, and Express application. Live mode is the default and does not substitute fictional sample records when SAP data is unavailable. The application does not execute payments or modify financial records.

## Requirements

- Node.js 20 or newer
- npm

## Start locally

From the project root, run these commands in separate terminals:

```sh
npm run dev:backend
npm run dev:frontend
```

The API listens at `http://127.0.0.1:3000`. The Vite frontend listens at `http://localhost:5173`. The dashboard and search pages load records from the backend; demo mode does not require SAP or Ollama.

## Data modes

Set `DATA_MODE` in `backend/.env`; the default is `live`. `DATA_MODE=live` selects live mode; the old value `DATA_MODE=sap` remains an alias. `DATA_MODE=demo` explicitly opts in to fictional sample data. Set `UPCOMING_DAYS` to an integer from 1 to 365; the default upcoming period is 30 calendar days, including today and the last day of the period.

- `DATA_MODE=demo` serves fictional obligations from the backend mock dataset, tagged `dataMode: "demo"` and `dataSource: "demo"`. This works without SAP or Ollama.
- Live mode reads supplier invoice records from the configured SAP OData service. If SAP cannot return valid records, the API returns an error; it never substitutes or merges demo records.
- The configured API Management OData service is `/API_SUPPLIERINVOICE_PROCESS_SRV`, and its verified entity set is `A_SupplierInvoice` (OData V2). The service document, metadata, and bounded invoice reads were successfully verified using `Accept-Encoding: gzip, deflate`; the API Management route rejects Brotli (`br`).
- The live entity provides invoice fields, not verified payment obligations. Payment status, clearing date, due date, and supplier name are not available from the verified entity. Financial payment-summary cards therefore remain unavailable in live mode.
- Supplier listing only requests `A_Supplier` when the configured OData service document lists that entity set. Supplier master data is not used as invoice or payment data.

The mock data is illustrative and is not a verified SAP transaction record. Supplier identifiers, document references, dates, amounts, statuses, and names in it are fictional. Missing document dates and payment references are returned as `null`. Response limitations identify the demo nature and unverified clearing information.

## API

- `GET /health` and `GET /api/health` — application process health, selected data mode, and dependency states. Health does not make an SAP request and does not mean SAP is connected.
- `GET /api/sap/status` — makes authenticated, read-only `GET` requests to the configured OData service document and a bounded supplier-invoice query, using the existing SAP Basic Authentication settings and optional `SAP_CLIENT`. SAP connectivity and invoice-data availability are reported separately. States include `not_configured`, `connected`, `authentication_failed`, `authorization_failed`, `unavailable`, `other_error`, and `unknown`.
- `GET /api/suppliers` — demo suppliers in demo mode; read-only supplier identifiers from `A_Supplier` in live mode. Optional `search`, `top` (1–100), and `skip` (0–1,000,000).
- `GET /api/payments` — filtered, paginated records from the selected source. Live mode returns SAP supplier invoices; supported filters are `search`, `supplierId`, `companyCode`, `currency`, `minAmount`, `maxAmount`, `top`, and `skip`. Payment-status and due-date filters are rejected in live mode because those fields are not verified.
- `GET /api/payments/:id` — safe read-only detail lookup.
- `GET /api/payments/summary` — summary using the same supported filters as the records list. Demo metrics are grouped by currency; live payment-obligation metrics explicitly return `status: "unavailable"` until payment status and due dates can be verified.
- `GET /api/payments/export` — CSV for all matching filtered records, with spreadsheet-formula prefixes escaped.
- `POST /api/ai/payments` — read-only Ollama assistant. Accepts `{ "prompt": "...", "filters": { ... } }`; the backend retrieves and filters records before sending at most 100 selected-source records and a summary to Ollama. Live invoices are identified as invoices, not confirmed obligations. Action requests are rejected.
- `GET /api/invoices` — legacy list alias with the same selected-source behavior as `/api/payments`; `/api/invoices/:id` remains demo-only.
- `POST /api/businesspartners` returns 410; Business Partner creation is not part of this application. No payment-write endpoint exists.

Payment-status totals use only records marked `Pending`, `Overdue`, or `Paid` and usable amount/currency values. Overdue and upcoming date totals also require a usable due date. `Unknown` statuses and missing financial/date information are excluded from the associated totals and disclosed in `limitations`. The upcoming window includes today through `UPCOMING_DAYS` days after today.

## SAP configuration and verified capabilities

The existing SAP client is configured through `SAP_BASE_URL`, `SAP_USERNAME`, `SAP_PASSWORD`, optional `SAP_CLIENT`, and `SAP_ODATA_PATH` in `backend/.env`. Reference values are in [backend/.env.example](./backend/.env.example). Credentials must remain private and must never be committed. The SAP URL must use HTTPS, OData requests remain on the configured host, and redirects are disabled. Authentication is HTTP Basic using the configured username and password; the current SAP client is `100`.

The SAP API Management service path is `/API_SUPPLIERINVOICE_PROCESS_SRV`; the configured authentication uses HTTP Basic credentials and SAP client `100`. The application queries `A_SupplierInvoice` using OData V2 and the selected fields confirmed by the service metadata: `SupplierInvoice`, `FiscalYear`, `CompanyCode`, `DocumentDate`, `PostingDate`, `SupplierInvoiceIDByInvcgParty`, `InvoicingParty`, `DocumentCurrency`, `InvoiceGrossAmount`, `PaymentTerms`, `DueCalculationBaseDate`, `NetPaymentDays`, `PaymentBlockingReason`, `SupplierInvoiceStatus`, `PaymentReference`, and `InvoiceReference`. The service supports `$select`, `$filter`, `$top`, `$skip`, and `$inlinecount=allpages`.

The mapper returns real invoice identifiers, supplier identifiers, company code, invoice reference, document/posting dates, gross invoice amount, currency, and payment reference when present. The entity does not provide supplier name, verified due date, payment/clearing status, or clearing date. `SupplierInvoiceStatus` is retained as an invoice-document status and is not interpreted as payment status. `DueCalculationBaseDate` and payment-term properties are not used to derive due dates because the business rules are unverified. No live outstanding, overdue, upcoming, or completed-payment metric is calculated from invoice gross amounts. Live summaries instead return a separately labelled invoice gross amount summary grouped by currency and keep unsupported payment metrics unavailable.

The SAP connection check is a point-in-time request and SAP/API Management may still be unavailable. A successful previous read does not guarantee current availability; an HTTP 504 is reported as unavailable and live requests do not fall back to demo data. To enable verified payment-obligation summaries, an SAP administrator must provide an accounting/clearing source or document the applicable payment/clearing entity, field semantics, due-date business rules, and required permissions.

## Validate and run the backend

```sh
npm --prefix backend run validate:config
npm --prefix backend run check:syntax
npm --prefix backend test
npm --prefix backend run check
```

Use `npm --prefix backend run dev` for development and `npm --prefix backend start` for production startup. The frontend dashboard, search page, and assistant use the backend APIs. Run `npm --prefix frontend run lint` and `npm --prefix frontend run build` to validate the frontend.
