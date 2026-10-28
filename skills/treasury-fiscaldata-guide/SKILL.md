---
name: treasury-fiscaldata-guide
description: "Use treasury_* tools for multi-step Treasury fiscal analysis: establish comparable reporting periods, retrieve complete datasets, and analyze staged tables without double-counting fiscal totals."
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this server for Treasury fiscal accounts, debt outstanding, the average interest Treasury pays on outstanding securities, and statutory reporting exchange rates. Establish the measure before choosing a dataset: average borrowing costs and reporting exchange rates do not answer questions about current market yields or spot FX.

## Identifiers

Resolve an endpoint and its field names through `treasury_list_datasets`. Its catalog is curated; an absent entry does not establish that Treasury lacks the dataset. For an unlisted endpoint or field, consult Treasury's documentation before querying it.

Read category values from records for the period being studied. A field name identifies a column, not the set of values that column contains; security descriptions and country names must match Treasury's returned vocabulary.

The input `canvas_id` requests staging; it does not choose a table name or identify a destination canvas. The returned `canvas_id` is the server-assigned table name. Use that returned name for dataframe inspection and SQL. A SQL result persisted with `register_as` instead returns its name in `registered_as`.

## Gates

- Establish coverage before calculating a total, minimum, maximum, or trend. A generic dataset query fetches one page, and staging stores only that page. Walk the remaining pages with the same selection and sort, retaining each returned table name. Convenience series can return a short inline preview; compare the response counts and notices, then inspect the staged rows before analyzing the series.
- Verify that each staged table exists and inspect its provenance and schema before SQL. Staging can fail or be unavailable, and tables expire. An absent table requires re-fetching the source data, not inventing a table name.
- Use the staged schema rather than convenience-response property names. For example, a debt response's `total_debt` corresponds to the raw staged column `tot_pub_debt_out_amt`; interest responses rename `avg_interest_rate_amt` to `avg_interest_rate_pct` inline.
- Align row dates before comparing series. A filtered interest-rate latest result can be the last published month for a discontinued security type. Filtered exchange-rate latest results can span quarters; the top-level newest date does not date every row. Use a common reporting period or disclose the difference.
- Inspect fiscal row structure before aggregating. MTS hierarchy rows and MSPD security roll-ups include totals alongside components. Select a published total or mutually exclusive components; do not sum both. Discover the relevant identifiers and labels from the selected period rather than assuming fixed labels.
- Match units and period basis before combining measures. Some catalog datasets use millions or billions. A monthly amount and a fiscal-year-to-date amount are different measures; summing successive FYTD snapshots counts earlier months repeatedly. Preserve missing values rather than converting the string `"null"` into zero.
- Check SQL coverage as well as source coverage. `row_count_capped` means the response count is a cap, not the full result size; a smaller preview can hide additional rows even when the count is exact. Materializing a SQL result cannot restore source pages that were never staged.

## Core chain

Choose the fiscal measure and reporting period → discover endpoint, fields, and actual category values → retrieve the required pages or series → inspect staged schemas and coverage → calculate on comparable rows → report the measure, units, period, and any remaining coverage limit.

## Workflows

**Staged analysis.** Treasury source tools can stage results as DataCanvas tables, and the response carries a `canvas_id`. Call `treasury_dataframe_describe` for the staged table and column names before writing SQL, then `treasury_dataframe_query` with a read-only query. Each source staging request creates a separate table on the tenant's shared canvas; passing a previous output name back as input does not append rows. Tables expire, so retain the source selection needed to fetch them again.

**Multi-page pull.** Keep endpoint, fields, filters, sort, and page size consistent while walking pages. Stage each page separately, verify its source parameters, then combine disjoint pages with `UNION ALL`. Run the aggregate over the combined relation, not separately over inline previews. If the source changes during retrieval, reconcile the fetched coverage before claiming a complete snapshot.

**Latest comparison.** Retrieve the relevant types or countries, inspect each row's date, and choose a shared period before calculating differences. For exchange-rate history, retain both `record_date` and `effective_date`: Treasury can amend a quarter's rate under the same record date. Establish which effective version the task needs before collapsing rows.

**Fiscal breakdown.** Inspect a bounded period's hierarchy identifiers, descriptions, and amount columns. Select one consistent level and one period basis, verify units from the dataset description, then aggregate. Keep classification identifiers available so the chosen population remains auditable.

## References

- [SQL analysis patterns](references/sql-analysis.md): missing values, raw column names, disjoint-page unions, and comparable dates.
