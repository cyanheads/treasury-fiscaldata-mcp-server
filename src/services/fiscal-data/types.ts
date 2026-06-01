/**
 * @fileoverview Shared types for the Treasury Fiscal Data API service and tools.
 * @module services/fiscal-data/types
 */

/** A single field descriptor from the embedded dataset catalog. */
export interface DatasetField {
  label: string;
  name: string;
  type: string;
}

/** A single dataset entry in the embedded catalog. */
export interface DatasetEntry {
  category: DatasetCategory;
  description: string;
  endpoint: string;
  fields: DatasetField[];
  name: string;
  update_cadence: string;
}

/** Dataset category values used across catalog and tool input. */
export type DatasetCategory =
  | 'debt'
  | 'interest_rates'
  | 'exchange_rates'
  | 'revenue_spending'
  | 'savings_bonds'
  | 'securities'
  | 'other';

/** API response envelope from the Fiscal Data API. */
export interface FiscalDataEnvelope {
  data: Record<string, string>[];
  links: {
    self: string;
    first: string | null;
    prev: string | null;
    next: string | null;
    last: string | null;
  };
  meta: {
    count: number;
    labels: Record<string, string>;
    dataTypes: Record<string, string>;
    dataFormats: Record<string, string>;
    'total-count': number;
    'total-pages': number;
  };
}

/** Filter condition for the API. */
export interface FilterCondition {
  field: string;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value: string | string[];
}
