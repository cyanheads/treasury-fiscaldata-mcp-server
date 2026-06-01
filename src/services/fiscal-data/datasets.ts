/**
 * @fileoverview Static embedded catalog of Treasury Fiscal Data API endpoints.
 * The Treasury API has no programmatic catalog endpoint — this list is curated
 * from the official documentation and covers the primary documented datasets.
 * @module services/fiscal-data/datasets
 */

import type { DatasetEntry } from './types.js';

/** Full embedded dataset catalog. */
export const DATASETS: DatasetEntry[] = [
  // ── debt ──────────────────────────────────────────────────────────────────
  {
    endpoint: '/v2/accounting/od/debt_to_penny',
    name: 'Debt to the Penny',
    description:
      'Daily national debt outstanding broken into publicly-held debt and intragovernmental holdings. Records go back to 1993-01-04. Only recorded on business days.',
    category: 'debt',
    update_cadence: 'Daily (business days)',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'debt_held_public_amt', label: 'Debt Held by the Public', type: 'CURRENCY' },
      { name: 'intragov_hold_amt', label: 'Intragovernmental Holdings', type: 'CURRENCY' },
      { name: 'tot_pub_debt_out_amt', label: 'Total Public Debt Outstanding', type: 'CURRENCY' },
      { name: 'src_line_nbr', label: 'Source Line Number', type: 'INTEGER' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_fiscal_quarter', label: 'Fiscal Quarter', type: 'QUARTER' },
      { name: 'record_calendar_year', label: 'Calendar Year', type: 'YEAR' },
      { name: 'record_calendar_quarter', label: 'Calendar Quarter', type: 'QUARTER' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
      { name: 'record_calendar_day', label: 'Calendar Day', type: 'DAY' },
    ],
  },
  {
    endpoint: '/v1/debt/top/top_state',
    name: 'Treasury Offset Program – State Collections',
    description:
      'State collections through the Treasury Offset Program, which withholds federal payments to collect debts owed to the federal government.',
    category: 'debt',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'state_nm', label: 'State Name', type: 'STRING' },
      { name: 'offset_type_desc', label: 'Offset Type', type: 'STRING' },
      { name: 'payment_type_desc', label: 'Payment Type', type: 'STRING' },
      { name: 'amt_offset', label: 'Amount Offset', type: 'CURRENCY' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
    ],
  },

  // ── interest_rates ────────────────────────────────────────────────────────
  {
    endpoint: '/v2/accounting/od/avg_interest_rates',
    name: 'Average Interest Rates on U.S. Treasury Securities',
    description:
      'Average interest rates Treasury pays on outstanding marketable and non-marketable securities by type — Bills, Notes, Bonds, TIPS, FRN, and aggregate totals. Updated end-of-month.',
    category: 'interest_rates',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'security_type_desc', label: 'Security Type', type: 'STRING' },
      { name: 'security_desc', label: 'Security Description', type: 'STRING' },
      { name: 'avg_interest_rate_amt', label: 'Average Interest Rate (%)', type: 'PERCENTAGE' },
      { name: 'src_line_nbr', label: 'Source Line Number', type: 'INTEGER' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_fiscal_quarter', label: 'Fiscal Quarter', type: 'QUARTER' },
      { name: 'record_calendar_year', label: 'Calendar Year', type: 'YEAR' },
      { name: 'record_calendar_quarter', label: 'Calendar Quarter', type: 'QUARTER' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },
  {
    endpoint: '/v1/accounting/od/interest_expense',
    name: 'Interest Expense on U.S. Public Debt',
    description: 'Monthly interest expense paid by Treasury by fund and financing account.',
    category: 'interest_rates',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'expense_catg_desc', label: 'Expense Category', type: 'STRING' },
      { name: 'expense_group_desc', label: 'Expense Group', type: 'STRING' },
      { name: 'expense_type_desc', label: 'Expense Type', type: 'STRING' },
      { name: 'month_expense_amt', label: 'Monthly Expense', type: 'CURRENCY' },
      { name: 'fytd_expense_amt', label: 'Fiscal Year-to-Date Expense', type: 'CURRENCY' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_fiscal_quarter', label: 'Fiscal Quarter', type: 'QUARTER' },
      { name: 'record_calendar_year', label: 'Calendar Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },

  // ── exchange_rates ────────────────────────────────────────────────────────
  {
    endpoint: '/v1/accounting/od/rates_of_exchange',
    name: 'Treasury Reporting Rates of Exchange',
    description:
      'Official Treasury statutory exchange rates — foreign currency units per 1 USD — for ~130 countries. Published quarterly (March 31, June 30, Sep 30, Dec 31). Required for federal agencies converting foreign-currency amounts to USD for official reporting. Not market rates.',
    category: 'exchange_rates',
    update_cadence: 'Quarterly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'country', label: 'Country', type: 'STRING' },
      { name: 'currency', label: 'Currency', type: 'STRING' },
      {
        name: 'country_currency_desc',
        label: 'Country-Currency',
        type: 'STRING',
      },
      {
        name: 'exchange_rate',
        label: 'Exchange Rate (foreign units per 1 USD)',
        type: 'NUMBER',
      },
      { name: 'effective_date', label: 'Effective Date', type: 'DATE' },
      { name: 'src_line_nbr', label: 'Source Line Number', type: 'INTEGER' },
    ],
  },

  // ── revenue_spending ──────────────────────────────────────────────────────
  {
    endpoint: '/v1/accounting/mts/mts_table_1',
    name: 'Monthly Treasury Statement (MTS) Table 1 – Receipts, Outlays, and Surplus/Deficit',
    description:
      'Federal government receipts, outlays, and the resulting surplus or deficit by month and fiscal year-to-date. The top-level summary of federal finances.',
    category: 'revenue_spending',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'line_code_nbr', label: 'Line Code Number', type: 'INTEGER' },
      { name: 'item_desc', label: 'Item Description', type: 'STRING' },
      {
        name: 'current_month_gross_outly_amt',
        label: 'Current Month Gross Outlays',
        type: 'CURRENCY',
      },
      { name: 'current_fytd_gross_outly_amt', label: 'Fiscal YTD Gross Outlays', type: 'CURRENCY' },
      {
        name: 'prior_fytd_gross_outly_amt',
        label: 'Prior Fiscal YTD Gross Outlays',
        type: 'CURRENCY',
      },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_fiscal_quarter', label: 'Fiscal Quarter', type: 'QUARTER' },
      { name: 'record_calendar_year', label: 'Calendar Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },
  {
    endpoint: '/v1/accounting/mts/mts_table_4',
    name: 'Monthly Treasury Statement (MTS) Table 4 – Receipts by Source',
    description:
      'Federal receipts by source category (individual income tax, corporate income tax, excise, etc.) for the current month and fiscal year-to-date.',
    category: 'revenue_spending',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'classification_desc', label: 'Classification Description', type: 'STRING' },
      { name: 'parent_desc', label: 'Parent Description', type: 'STRING' },
      {
        name: 'current_month_gross_rcpt_amt',
        label: 'Current Month Gross Receipts',
        type: 'CURRENCY',
      },
      { name: 'current_fytd_gross_rcpt_amt', label: 'Fiscal YTD Gross Receipts', type: 'CURRENCY' },
      {
        name: 'prior_fytd_gross_rcpt_amt',
        label: 'Prior Fiscal YTD Gross Receipts',
        type: 'CURRENCY',
      },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },
  {
    endpoint: '/v1/accounting/mts/mts_table_5',
    name: 'Monthly Treasury Statement (MTS) Table 5 – Outlays by Agency',
    description:
      'Federal outlays by agency for the current month and fiscal year-to-date. Many rows have "null" amounts for reporting periods before an agency existed or where no spending occurred.',
    category: 'revenue_spending',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'classification_desc', label: 'Agency / Classification', type: 'STRING' },
      { name: 'parent_desc', label: 'Parent Agency', type: 'STRING' },
      {
        name: 'current_month_gross_outly_amt',
        label: 'Current Month Gross Outlays',
        type: 'CURRENCY',
      },
      { name: 'current_fytd_gross_outly_amt', label: 'Fiscal YTD Gross Outlays', type: 'CURRENCY' },
      {
        name: 'prior_fytd_gross_outly_amt',
        label: 'Prior Fiscal YTD Gross Outlays',
        type: 'CURRENCY',
      },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },
  {
    endpoint: '/v1/accounting/dts/operating_cash_balance',
    name: 'Daily Treasury Statement (DTS) – Operating Cash Balance',
    description:
      'Daily balance of the Treasury General Account (TGA) at the Federal Reserve — the primary operating account of the U.S. government. Also includes Tax and Loan account balances.',
    category: 'revenue_spending',
    update_cadence: 'Daily (business days)',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'account_type', label: 'Account Type', type: 'STRING' },
      { name: 'open_today_bal', label: 'Opening Balance Today', type: 'CURRENCY0' },
      { name: 'close_today_bal', label: 'Closing Balance Today', type: 'CURRENCY0' },
      { name: 'open_mon_bal', label: 'Opening Balance Month', type: 'CURRENCY0' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_calendar_year', label: 'Calendar Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },
  {
    endpoint: '/v1/accounting/dts/deposits_withdrawals_operating_cash',
    name: 'Daily Treasury Statement (DTS) – Deposits and Withdrawals',
    description:
      'Daily deposits to and withdrawals from Treasury operating cash — tax receipts, Social Security payments, federal payroll, etc.',
    category: 'revenue_spending',
    update_cadence: 'Daily (business days)',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'transaction_type', label: 'Transaction Type (deposit/withdrawal)', type: 'STRING' },
      { name: 'classification_desc', label: 'Classification Description', type: 'STRING' },
      { name: 'today_amt', label: 'Today Amount', type: 'CURRENCY0' },
      { name: 'mtd_amt', label: 'Month-to-Date Amount', type: 'CURRENCY0' },
      { name: 'fytd_amt', label: 'Fiscal Year-to-Date Amount', type: 'CURRENCY0' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },

  // ── savings_bonds ─────────────────────────────────────────────────────────
  {
    endpoint: '/v2/accounting/od/savings_bonds_report',
    name: 'Savings Bonds Summary',
    description:
      'Monthly summary of U.S. savings bonds outstanding by series (EE, I, HH, and legacy series).',
    category: 'savings_bonds',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'bond_series_cd', label: 'Bond Series Code', type: 'STRING' },
      { name: 'issue_price', label: 'Issue Price', type: 'CURRENCY' },
      { name: 'outstanding_bond_cd', label: 'Outstanding Bond Code', type: 'STRING' },
      { name: 'outstanding_amt', label: 'Outstanding Amount', type: 'CURRENCY' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },

  // ── securities ────────────────────────────────────────────────────────────
  {
    endpoint: '/v1/accounting/od/upcoming_auctions',
    name: 'Upcoming Treasury Securities Auctions',
    description:
      'Scheduled future Treasury securities auctions — Bills, Notes, Bonds, TIPS, FRN. Useful for tracking the auction calendar.',
    category: 'securities',
    update_cadence: 'Weekly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'security_type', label: 'Security Type', type: 'STRING' },
      { name: 'security_term', label: 'Security Term', type: 'STRING' },
      { name: 'announcement_date', label: 'Announcement Date', type: 'DATE' },
      { name: 'auction_date', label: 'Auction Date', type: 'DATE' },
      { name: 'issue_date', label: 'Issue Date', type: 'DATE' },
      { name: 'offering_amt', label: 'Offering Amount', type: 'CURRENCY' },
    ],
  },
  {
    endpoint: '/v1/accounting/od/auction_results',
    name: 'Treasury Securities Auction Results',
    description:
      'Results of completed Treasury securities auctions including accepted bids, high rate, bid-to-cover ratio, and amounts awarded to competitive and non-competitive bidders.',
    category: 'securities',
    update_cadence: 'Daily (on auction days)',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'security_type', label: 'Security Type', type: 'STRING' },
      { name: 'security_term', label: 'Security Term', type: 'STRING' },
      { name: 'cusip', label: 'CUSIP', type: 'STRING' },
      { name: 'high_rate', label: 'High Rate (%)', type: 'PERCENTAGE' },
      { name: 'high_yield', label: 'High Yield (%)', type: 'PERCENTAGE' },
      { name: 'offering_amt', label: 'Offering Amount', type: 'CURRENCY' },
      { name: 'total_tendered', label: 'Total Tendered', type: 'CURRENCY' },
      { name: 'total_accepted', label: 'Total Accepted', type: 'CURRENCY' },
      { name: 'bid_to_cover_ratio', label: 'Bid-to-Cover Ratio', type: 'NUMBER' },
      { name: 'auction_date', label: 'Auction Date', type: 'DATE' },
      { name: 'issue_date', label: 'Issue Date', type: 'DATE' },
    ],
  },
  {
    endpoint: '/v2/accounting/od/securities_outstanding',
    name: 'Securities Outstanding',
    description:
      'Outstanding marketable and non-marketable Treasury securities by type and series.',
    category: 'securities',
    update_cadence: 'Monthly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'security_class_desc', label: 'Security Class', type: 'STRING' },
      { name: 'security_type_desc', label: 'Security Type', type: 'STRING' },
      {
        name: 'outstanding_held_public_mil_amt',
        label: 'Held by Public (millions)',
        type: 'CURRENCY',
      },
      {
        name: 'outstanding_intragov_mil_amt',
        label: 'Intragovernmental (millions)',
        type: 'CURRENCY',
      },
      { name: 'outstanding_mil_amt', label: 'Total Outstanding (millions)', type: 'CURRENCY' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
      { name: 'record_calendar_month', label: 'Calendar Month', type: 'MONTH' },
    ],
  },

  // ── other ─────────────────────────────────────────────────────────────────
  {
    endpoint: '/v1/accounting/od/utf_qtr_yields',
    name: 'Unemployment Trust Fund Quarterly Yields',
    description: 'Quarterly yield rates on investments in the Unemployment Trust Fund.',
    category: 'other',
    update_cadence: 'Quarterly',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'yield_rate', label: 'Yield Rate (%)', type: 'PERCENTAGE' },
    ],
  },
  {
    endpoint: '/v1/accounting/od/statement_net_cost',
    name: 'Statement of Net Cost',
    description:
      'Annual consolidated net cost of U.S. government operations by agency and function.',
    category: 'other',
    update_cadence: 'Annually',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'agency_nm', label: 'Agency Name', type: 'STRING' },
      { name: 'gross_cost_amt', label: 'Gross Cost', type: 'CURRENCY' },
      { name: 'earned_revenue_amt', label: 'Earned Revenue', type: 'CURRENCY' },
      { name: 'net_cost_amt', label: 'Net Cost', type: 'CURRENCY' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
    ],
  },
  {
    endpoint: '/v1/accounting/od/balance_sheets',
    name: 'Balance Sheets',
    description:
      'Annual consolidated balance sheet of the U.S. government — assets, liabilities, and net position.',
    category: 'other',
    update_cadence: 'Annually',
    fields: [
      { name: 'record_date', label: 'Record Date', type: 'DATE' },
      { name: 'line_code_nbr', label: 'Line Code Number', type: 'INTEGER' },
      { name: 'item_desc', label: 'Item Description', type: 'STRING' },
      { name: 'position_bil_amt', label: 'Position (billions)', type: 'CURRENCY' },
      { name: 'record_fiscal_year', label: 'Fiscal Year', type: 'YEAR' },
    ],
  },
];
