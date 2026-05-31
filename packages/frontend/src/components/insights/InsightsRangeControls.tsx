import React, { useEffect, useState } from 'react';
import { PlayCircle, Circle, X } from 'lucide-react';
import { DateTimePicker } from '../ui/DateTimePicker';
import {
  TIMELINE_OPTIONS,
  type ModelInsightRangeKey,
} from '../../lib/model-insights';

export interface InsightsRangeControlsProps {
  activeRange: ModelInsightRangeKey | null;
  isCustomRangeActive: boolean;
  onRangeSelect: (key: ModelInsightRangeKey) => void;
  onCustomRangeSelect: (startMs: number, endMs: number) => void;
}

export const InsightsRangeControls: React.FC<InsightsRangeControlsProps> = ({
  activeRange,
  isCustomRangeActive,
  onRangeSelect,
  onCustomRangeSelect,
}) => {
  const [showCustomPickers, setShowCustomPickers] = useState(isCustomRangeActive);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    if (isCustomRangeActive) {
      setShowCustomPickers(true);
    }
  }, [isCustomRangeActive]);

  useEffect(() => {
    if (!showCustomPickers || !startDate || !endDate) return;
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return;
    onCustomRangeSelect(startMs, endMs);
  }, [showCustomPickers, startDate, endDate, onCustomRangeSelect]);

  const handlePresetClick = (key: ModelInsightRangeKey) => {
    setShowCustomPickers(false);
    setStartDate('');
    setEndDate('');
    onRangeSelect(key);
  };

  const handleCustomToggle = () => {
    setShowCustomPickers(true);
  };

  const handleClearDates = () => {
    setStartDate('');
    setEndDate('');
  };

  const presetButtonClass = (pressed: boolean) =>
    `px-3 py-1.5 rounded-md text-xs font-medium transition-colors duration-150 ${
      pressed
        ? 'bg-primary/20 text-primary border border-primary/30'
        : 'bg-bg-glass text-text-secondary border border-border-glass hover:bg-bg-hover'
    }`;

  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {TIMELINE_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => handlePresetClick(opt.key)}
            className={presetButtonClass(!showCustomPickers && activeRange === opt.key)}
            aria-pressed={!showCustomPickers && activeRange === opt.key}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          onClick={handleCustomToggle}
          className={presetButtonClass(showCustomPickers || isCustomRangeActive)}
          aria-pressed={showCustomPickers || isCustomRangeActive}
        >
          Custom
        </button>
      </div>
      {showCustomPickers && (
        <div className="w-full sm:w-auto flex items-center gap-2">
          <div className="flex items-center gap-2">
            <PlayCircle size={24} color="#94a3b8" />
            <DateTimePicker
              value={startDate}
              onChange={setStartDate}
              placeholder="Start date"
            />
          </div>
          <div className="flex items-center gap-2">
            <Circle size={24} color="#94a3b8" />
            <DateTimePicker
              value={endDate}
              onChange={setEndDate}
              placeholder="End date"
            />
          </div>
          {(startDate || endDate) && (
            <button
              type="button"
              onClick={handleClearDates}
              className="rounded-md text-text-muted hover:text-text hover:bg-bg-hover transition-colors duration-fast bg-transparent border-0 cursor-pointer"
              title="Clear date filters"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
