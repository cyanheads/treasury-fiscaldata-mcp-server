# treasury-fiscaldata-mcp-server — idea

Official US Treasury Fiscal Data — the national debt, federal revenue and spending, interest rates on Treasury securities, daily Treasury statements, and official government exchange rates — across 80+ datasets under one uniform, keyless API.

This is the authoritative source for the US government's own books: the debt-to-the-penny, what Treasury pays in interest, the official FX rates agencies must use for reporting. A single consistent query interface spans every dataset, which makes it a clean, high-value wrap.

**Audience:** Economic and policy analysts, journalists, fintech/civic-tech builders, anyone tracking the debt or federal finances, and agents answering "what's the national debt?" or "what interest rate does Treasury pay?"

## User Goals

- Get the current (or historical) national debt
- Look up the average interest rate Treasury pays on its securities
- Find the official government exchange rate for a currency (for USD reporting)
- Pull federal revenue / spending / deficit figures over time
- Run a filtered query against any Fiscal Data dataset

## API Surface

One base, one query grammar, ~80 datasets — uniform `fields` / `filter` / `sort` / pagination across all of them. Keyless. Base: `api.fiscaldata.treasury.gov/services/api/fiscal_service/`.

| Dataset (example) | Path | Purpose |
|:------------------|:-----|:--------|
| Debt to the Penny | `/v2/accounting/od/debt_to_penny` | Daily total public debt |
| Avg Interest Rates | `/v2/accounting/od/avg_interest_rates` | Rates by security type over time |
| Rates of Exchange | `/v1/accounting/od/rates_of_exchange` | Official quarterly FX rates for USD reporting |
| Monthly Treasury Statement | `/v1/accounting/mts/...` | Federal receipts, outlays, deficit |
| Treasury Securities Auctions | `/v1/accounting/od/auctions_query` | Auction results |

The query grammar is the whole interface: `fields=`, `filter=col:op:value` (`eq`,`gt`,`lt`,`in`…), `sort=`, `page[size]`/`page[number]`. Every dataset shares it, so one generic query tool covers the long tail while convenience tools cover the headline questions.

## Tool Surface (sketch)

```
treasury_list_datasets   — discover available datasets: name, endpoint path, description,
                           date range, update cadence, and the fields each exposes.
                           Required for the generic query tool — there are ~80 datasets
                           and the agent needs the path + field names.

treasury_query_dataset   — generic query against any dataset by path. Inputs: fields,
                           filter (column:operator:value), sort, pagination. Returns rows
                           + metadata (counts, applied filters). Large results spill to
                           DataCanvas for SQL. The power tool for the long tail.

treasury_get_debt        — national debt convenience: latest, a date, or a time series
                           (debt_to_penny). Returns total public debt outstanding with
                           the breakdown. The single most-asked question, one call.

treasury_get_exchange_rates — official Treasury exchange rate for a currency/country,
                           latest or by reporting quarter. These are the rates US agencies
                           must use to convert foreign currency for reporting — distinct
                           from market FX.

treasury_get_interest_rates — average interest rates Treasury pays by security type
                           (bills, notes, bonds, TIPS) over time. "What's the government's
                           cost of borrowing?"
```

## Design Notes

- Low-medium complexity — the API is unusually clean (one grammar everywhere), so the work is dataset/field **discovery** (80+ datasets, non-obvious paths) and translating the `filter=col:op:value` grammar into a friendly schema. `treasury_list_datasets` is what makes the generic query tool usable.
- **Convenience tools over the headline datasets** (debt, interest, FX) + **one generic query tool** for the rest is the right split — don't write 80 tools, but don't force everything through a raw query grammar either. The convenience tools answer the 80% case in one call.
- **Disambiguate "exchange rate."** Treasury's `rates_of_exchange` are *official reporting* rates (quarterly), not live market rates. Say so in the description — otherwise agents will use the wrong one for currency conversion.
- All datasets share pagination + metadata; surface applied filters and totals so the agent knows whether it saw the full set. DataCanvas fits time-series datasets (debt history, MTS).
- Fully keyless and stable (official government API).
- Composes with `usaspending` (spending awards vs. Treasury's top-line outlays/deficit), `secedgar` (corporate vs. sovereign finances), `worldbank` (US debt/deficit in global context), `congressgov` (appropriations and debt-limit legislation behind the numbers).
- Moonshot: a "fiscal snapshot" workflow — current debt, latest monthly deficit, and the trend in borrowing cost, assembled into one briefing.

**README one-liner:** "The US government's books — national debt, interest, exchange rates, and federal spending from Treasury Fiscal Data."
