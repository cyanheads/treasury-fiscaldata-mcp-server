# SQL analysis patterns

Replace every `df_PAGE_*` or `df_SOURCE` placeholder below with an existing name returned by a Treasury source tool or `treasury_dataframe_describe`. Confirm each referenced column in the staged schema. These examples use raw API column names, not the renamed properties in convenience-tool inline results.

## Preserve missing amounts

Treasury source values are strings. Convert the literal `null` to SQL NULL before a numeric cast; choose decimal precision and scale for the measure. Do not substitute zero for missing data. Report the number of missing observations when it affects the conclusion.

```sql
SELECT
  CAST(record_date AS DATE) AS observation_date,
  CAST(NULLIF(tot_pub_debt_out_amt, 'null') AS DECIMAL(24, 6)) AS debt_usd
FROM df_SOURCE
ORDER BY observation_date
```

## Combine disjoint pages before aggregating

Each generic dataset staging call stores one page in a new table. Confirm that these tables describe different pages of the same selection before using `UNION ALL`. Retain identifying columns in each page's projection. `UNION` can silently discard distinct source rows that happen to have identical projected values.

```sql
WITH observations AS (
  SELECT record_date, tot_pub_debt_out_amt FROM df_PAGE_1
  UNION ALL
  SELECT record_date, tot_pub_debt_out_amt FROM df_PAGE_2
)
SELECT
  COUNT(*) AS observations,
  MIN(CAST(record_date AS DATE)) AS first_date,
  MAX(CAST(record_date AS DATE)) AS last_date,
  MAX(CAST(NULLIF(tot_pub_debt_out_amt, 'null') AS DECIMAL(24, 6))) AS maximum_debt_usd
FROM observations
```

Coverage comes from fetching the required source pages and checking their provenance; a plausible date span alone does not prove completeness.

## Inspect the population before comparing rates

Discover which security descriptions occur in the requested range and how far each extends. A type's latest available observation need not be the latest month for the dataset.

```sql
SELECT
  security_desc,
  MIN(CAST(record_date AS DATE)) AS first_date,
  MAX(CAST(record_date AS DATE)) AS last_date,
  COUNT(*) AS observations
FROM df_SOURCE
GROUP BY security_desc
ORDER BY security_desc
```

Filter to a common reporting period before comparing rates. When joining datasets, establish each side's grain first: joining on date alone multiplies rows if either side contains several categories per date.

## Separate source coverage from SQL output

Use a single read-only SELECT, optionally with CTEs. Inspect `row_count_capped` and the returned preview before treating a SQL response as complete. Persisting a query with `register_as` makes the result available for subsequent queries; inspect that table before chaining analysis. It does not retrieve missing upstream pages.
