import React from 'react';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

export const HeroMetric: React.FC<{
  label: string;
  value: string;
  accentColor: string;
}> = ({ label, value, accentColor }) => (
  <div
    className="rounded-lg border border-border bg-bg-card px-4 py-3"
    style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
  >
    <div className="text-xs text-text-muted font-medium mb-1">{label}</div>
    <div className="text-xl font-semibold text-text truncate" title={value}>
      {value}
    </div>
  </div>
);

export const SectionMetric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[11px] text-text-muted font-medium mb-0.5">{label}</div>
    <div className="text-sm font-semibold text-text truncate" title={value}>
      {value}
    </div>
  </div>
);

export const LoadingSkeleton: React.FC = () => (
  <>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-bg-card px-4 py-3">
          <Skeleton height={10} width="40%" className="mb-2" />
          <Skeleton height={24} width="60%" />
        </div>
      ))}
    </div>
    {Array.from({ length: 3 }).map((_, i) => (
      <Card key={i} className="mb-4" dense>
        <Skeleton height={14} width="30%" className="mb-3" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
          {Array.from({ length: i === 2 ? 4 : 6 }).map((_, j) => (
            <div key={j}>
              <Skeleton height={10} width="50%" className="mb-1.5" />
              <Skeleton height={14} width="70%" />
            </div>
          ))}
        </div>
      </Card>
    ))}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <Skeleton height={16} width="40%" className="mb-3" />
          <Skeleton height={280} />
        </Card>
      ))}
    </div>
    <Card>
      <Skeleton height={16} width="30%" className="mb-3" />
      <Skeleton height={60} className="mb-2" />
      <Skeleton height={60} />
    </Card>
  </>
);
