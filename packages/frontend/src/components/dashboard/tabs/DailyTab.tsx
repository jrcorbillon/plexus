/**
 * @fileoverview DailyTab -- Dashboard tab showing per-day token usage broken
 * down by provider and (real) model.
 *
 * Data flow:
 *   1. On mount, `api.getDailyBreakdown(30)` fires once (no polling) and
 *      returns a flat array of leaf rows, each representing the summed
 *      token usage for one (day, provider, model) triple.
 *   2. A `useMemo` pivots that flat array into `Map<dayString, DayGrouping>`
 *      where each grouping carries the aggregated day-level totals plus the
 *      sorted leaf rows.
 *   3. The component renders collapsible day rows. Days are sorted
 *      descending (most recent first). Expanded days reveal nested
 *      provider/model rows sorted by total tokens descending.
 *
 * Styling follows the existing Plexus dark theme: only CSS variables are
 * used (no hardcoded colors), lucide-react icons replace any emoji, numeric
 * cells use `tabular-nums` and right alignment, and provider/model cells
 * use a monospace font.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { api, type DailyBreakdownRow } from '../../../lib/api';
import { formatNumber, formatTokens } from '../../../lib/format';
import { Card } from '../../ui/Card';

/**
 * One day's aggregated totals plus the leaf rows that roll up into it.
 *
 * `totalTokens` is `inputTokens + outputTokens + cachedTokens + cacheWriteTokens`,
 * matching the formula used by the rest of the dashboard. Leaf rows are kept
 * in the order returned by the API; the render layer re-sorts them by total
 * tokens descending when displaying.
 */
interface DayGrouping {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  leafRows: DailyBreakdownRow[];
}

/**
 * Total tokens for a leaf row (input + output + cached + cache write).
 * Kept in sync with the aggregation formula used everywhere else in the UI.
 */
const leafTotalTokens = (row: DailyBreakdownRow): number =>
  row.inputTokens + row.outputTokens + row.cachedTokens + row.cacheWriteTokens;

/** Lookback window in days. Matches the documented default for this tab. */
const DEFAULT_DAYS = 30;

/**
 * CSS grid template shared by the day header, day rows, sub-header, and
 * nested rows so all columns line up vertically.
 *
 * Column layout (left -> right):
 *   1. Date / Provider-Model (flexible, grows)
 *   2. Requests
 *   3. Total Tokens
 *   4. Input
 *   5. Cache
 *   6. Output
 *
 * Numeric columns are `minmax(72px, auto)` so they never clip formatted
 * values while staying as narrow as the content allows. The grid collapses
 * gracefully on narrow screens because the first column absorbs the slack.
 */
const GRID_COLS =
  'grid-cols-[minmax(140px,1fr)_minmax(72px,auto)_minmax(80px,auto)_minmax(72px,auto)_minmax(72px,auto)_minmax(72px,auto)]';

/** Shared cell utilities for right-aligned numeric cells. */
const NUMERIC_CELL_CLS = 'text-right tabular-nums';

export const DailyTab: React.FC = () => {
  const [data, setData] = useState<DailyBreakdownRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getDailyBreakdown(DEFAULT_DAYS).then((rows) => {
      if (!cancelled) {
        setData(rows);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Pivot the flat leaf-row array into per-day groupings with aggregated
   * totals. Days are returned in descending order (most recent first).
   */
  const dayGroupings = useMemo<DayGrouping[]>(() => {
    const byDay = new Map<string, DayGrouping>();
    for (const row of data) {
      let grouping = byDay.get(row.day);
      if (!grouping) {
        grouping = {
          day: row.day,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          leafRows: [],
        };
        byDay.set(row.day, grouping);
      }
      grouping.requests += row.requests;
      grouping.inputTokens += row.inputTokens;
      grouping.outputTokens += row.outputTokens;
      grouping.cachedTokens += row.cachedTokens;
      grouping.cacheWriteTokens += row.cacheWriteTokens;
      grouping.totalTokens += leafTotalTokens(row);
      grouping.leafRows.push(row);
    }
    // Sort each day's leaf rows by total tokens descending so the render
    // layer never has to re-sort (and we avoid calling hooks inside .map()).
    for (const grouping of byDay.values()) {
      grouping.leafRows.sort((a, b) => leafTotalTokens(b) - leafTotalTokens(a));
    }
    // Sort days descending by ISO date string (YYYY-MM-DD compares correctly).
    return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  }, [data]);

  /**
   * Toggle a day's expanded state. We always create a new Set so React
   * detects the change and re-renders. Multiple days can be expanded at
   * once; expanding one never collapses another.
   */
  const toggleDay = (day: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) {
        next.delete(day);
      } else {
        next.add(day);
      }
      return next;
    });
  };

  return (
    <div className="p-3 sm:p-6 transition-all duration-300">
      <div className="mb-4 sm:mb-6">
        <h1 className="font-heading text-2xl sm:text-3xl font-bold text-text m-0 mb-2">
          Daily Usage
        </h1>
        <p className="text-sm sm:text-[15px] text-text-secondary m-0">
          Daily token usage broken down by provider and model.
        </p>
      </div>

      <Card flush className="min-w-0">
        {loading ? (
          <div className="p-4 sm:p-5">
            <p className="text-sm text-text-muted">Loading...</p>
          </div>
        ) : dayGroupings.length === 0 ? (
          <div className="p-4 sm:p-5 flex items-center justify-center">
            <p className="text-sm text-text-muted">No usage data for this period.</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Sticky header row: Date | Requests | Total Tokens | Input | Cache | Output */}
            <div
              className={`sticky top-0 z-10 grid gap-2 sm:gap-3 items-center px-3 sm:px-4 py-2.5 bg-bg-card border-b border-border text-xs uppercase tracking-wide text-text-muted ${GRID_COLS}`}
            >
              <span>Date</span>
              <span className={NUMERIC_CELL_CLS}>Requests</span>
              <span className={NUMERIC_CELL_CLS}>Total Tokens</span>
              <span className={NUMERIC_CELL_CLS}>Input</span>
              <span className={NUMERIC_CELL_CLS}>Cache</span>
              <span className={NUMERIC_CELL_CLS}>Output</span>
            </div>

            {/* Day rows (and their nested breakdown when expanded) */}
            <div className="flex flex-col">
              {dayGroupings.map((day) => {
                const expanded = expandedDays.has(day.day);
                // Leaf rows are already sorted by total tokens descending in
                // the parent useMemo, so we render them directly here.
                return (
                  <div
                    key={day.day}
                    className="border-b border-border last:border-b-0 bg-bg-card"
                  >
                    {/* Collapsible day header */}
                    <button
                      type="button"
                      onClick={() => toggleDay(day.day)}
                      aria-expanded={expanded}
                      aria-controls={`daily-panel-${day.day}`}
                      className={`w-full text-left grid gap-2 sm:gap-3 items-center px-3 sm:px-4 py-3 transition-colors duration-fast hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline focus-visible:outline-primary focus-visible:outline-offset-[-2px] ${GRID_COLS}`}
                    >
                      <span className="flex items-center gap-2 min-w-0 text-text font-medium">
                        {expanded ? (
                          <ChevronDown size={16} className="flex-shrink-0 text-text-muted" />
                        ) : (
                          <ChevronRight size={16} className="flex-shrink-0 text-text-muted" />
                        )}
                        <span className="truncate font-mono text-sm">{day.day}</span>
                      </span>
                      <span className={`${NUMERIC_CELL_CLS} text-text`}>
                        {formatNumber(day.requests, 0)}
                      </span>
                      <span className={`${NUMERIC_CELL_CLS} text-text`}>
                        {formatTokens(day.totalTokens)}
                      </span>
                      <span className={`${NUMERIC_CELL_CLS} text-text`}>
                        {formatTokens(day.inputTokens)}
                      </span>
                      <span className={`${NUMERIC_CELL_CLS} text-text`}>
                        {formatTokens(day.cachedTokens)}
                      </span>
                      <span className={`${NUMERIC_CELL_CLS} text-text`}>
                        {formatTokens(day.outputTokens)}
                      </span>
                    </button>

                    {/* Nested provider/model breakdown */}
                    {expanded && (
                      <div
                        id={`daily-panel-${day.day}`}
                        className="bg-bg-subtle border-t border-border-glass"
                      >
                        {/* Sub-header: Provider / Model | Requests | Total | Input | Cache | Output */}
                        <div
                          className={`grid gap-2 sm:gap-3 items-center px-3 sm:px-4 py-2 text-[11px] uppercase tracking-wide text-text-muted border-b border-border-glass ${GRID_COLS}`}
                        >
                          <span className="pl-6">Provider / Model</span>
                          <span className={NUMERIC_CELL_CLS}>Requests</span>
                          <span className={NUMERIC_CELL_CLS}>Total</span>
                          <span className={NUMERIC_CELL_CLS}>Input</span>
                          <span className={NUMERIC_CELL_CLS}>Cache</span>
                          <span className={NUMERIC_CELL_CLS}>Output</span>
                        </div>

                        {day.leafRows.map((row) => (
                          <div
                            key={`${row.provider}::${row.model}`}
                            className={`grid gap-2 sm:gap-3 items-center px-3 sm:px-4 py-2.5 border-b border-border-glass last:border-b-0 ${GRID_COLS}`}
                          >
                            <span className="pl-6 min-w-0 font-mono text-sm text-text truncate">
                              {row.provider} / {row.model}
                            </span>
                            <span className={`${NUMERIC_CELL_CLS} text-text-muted`}>
                              {formatNumber(row.requests, 0)}
                            </span>
                            <span className={`${NUMERIC_CELL_CLS} text-text-muted`}>
                              {formatTokens(leafTotalTokens(row))}
                            </span>
                            <span className={`${NUMERIC_CELL_CLS} text-text-muted`}>
                              {formatTokens(row.inputTokens)}
                            </span>
                            <span className={`${NUMERIC_CELL_CLS} text-text-muted`}>
                              {formatTokens(row.cachedTokens)}
                            </span>
                            <span className={`${NUMERIC_CELL_CLS} text-text-muted`}>
                              {formatTokens(row.outputTokens)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};
