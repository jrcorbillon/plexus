import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { InsightsRangeSelection, ModelInsightRangeKey } from '../lib/model-insights';

export interface UseInsightsPageOptions<TData> {
  entityId: string;
  defaultRangeKey: ModelInsightRangeKey;
  checkIsConfigured: (entityId: string) => Promise<boolean>;
  fetchInsights: (entityId: string, selection: InsightsRangeSelection) => Promise<TData>;
}

function selectionKey(selection: InsightsRangeSelection): string {
  if (selection.kind === 'preset') {
    return `preset:${selection.key}`;
  }
  return `custom:${selection.startMs}:${selection.endMs}`;
}

export function useInsightsPage<TData>({
  entityId,
  defaultRangeKey,
  checkIsConfigured,
  fetchInsights,
}: UseInsightsPageOptions<TData>) {
  const [activeSelection, setActiveSelection] = useState<InsightsRangeSelection>({
    kind: 'preset',
    key: defaultRangeKey,
  });

  const [dataEntityId, setDataEntityId] = useState<string | null>(null);
  const [data, setData] = useState<TData | null>(null);

  const [errorEntityId, setErrorEntityId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [loadingEntityId, setLoadingEntityId] = useState<string | null>(entityId || null);

  const [configEntityId, setConfigEntityId] = useState<string | null>(null);
  const [isEntityConfigured, setIsEntityConfigured] = useState<boolean | null>(null);

  const fetchIdRef = useRef(0);
  const entityIdRef = useRef(entityId);
  const selectionKeyRef = useRef(selectionKey(activeSelection));

  const activeRange =
    activeSelection.kind === 'preset' ? activeSelection.key : null;

  useEffect(() => {
    selectionKeyRef.current = selectionKey(activeSelection);
  }, [activeSelection]);

  useEffect(() => {
    entityIdRef.current = entityId;
    ++fetchIdRef.current;
    setLoadingEntityId(entityId || null);
  }, [entityId]);

  useEffect(() => {
    let cancelled = false;
    const entityForThisCall = entityId;
    (async () => {
      try {
        const configured = await checkIsConfigured(entityForThisCall);
        if (!cancelled && entityIdRef.current === entityForThisCall) {
          setConfigEntityId(entityForThisCall);
          setIsEntityConfigured(configured);
        }
      } catch {
        if (!cancelled && entityIdRef.current === entityForThisCall) {
          setConfigEntityId(entityForThisCall);
          setIsEntityConfigured(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, checkIsConfigured]);

  const loadData = useCallback(
    async (selection: InsightsRangeSelection) => {
      if (!entityId) return;

      const fetchId = ++fetchIdRef.current;
      const entityForThisCall = entityId;
      setLoadingEntityId(entityForThisCall);
      setErrorEntityId(null);
      setError(null);

      try {
        const result = await fetchInsights(entityForThisCall, selection);
        if (fetchId === fetchIdRef.current && entityIdRef.current === entityForThisCall) {
          setDataEntityId(entityForThisCall);
          setData(result);
        }
      } catch (err) {
        if (fetchId === fetchIdRef.current && entityIdRef.current === entityForThisCall) {
          setErrorEntityId(entityForThisCall);
          setError(err instanceof Error ? err.message : 'Failed to load insights');
          setDataEntityId(null);
          setData(null);
        }
      } finally {
        if (fetchId === fetchIdRef.current && entityIdRef.current === entityForThisCall) {
          setLoadingEntityId(null);
        }
      }
    },
    [entityId, fetchInsights]
  );

  const isConfiguredForCurrentEntity =
    configEntityId === entityId ? isEntityConfigured : null;
  const isLoadingCurrentEntity = loadingEntityId === entityId;
  const errorForCurrentEntity = errorEntityId === entityId ? error : null;
  const dataForCurrentEntity = dataEntityId === entityId ? data : null;

  const serializedSelection = useMemo(
    () => selectionKey(activeSelection),
    [activeSelection]
  );

  useEffect(() => {
    if (entityIdRef.current !== entityId) return;

    if (isConfiguredForCurrentEntity === null) {
      return;
    }
    if (isConfiguredForCurrentEntity === false) {
      setLoadingEntityId(null);
      setDataEntityId(null);
      setData(null);
      return;
    }
    loadData(activeSelection);
  }, [serializedSelection, loadData, isConfiguredForCurrentEntity, entityId, activeSelection]);

  const handleRangeSelect = useCallback((key: ModelInsightRangeKey) => {
    setActiveSelection({ kind: 'preset', key });
  }, []);

  const handleCustomRangeSelect = useCallback((startMs: number, endMs: number) => {
    setActiveSelection((prev) => {
      if (
        prev.kind === 'custom' &&
        prev.startMs === startMs &&
        prev.endMs === endMs
      ) {
        return prev;
      }
      return { kind: 'custom', startMs, endMs };
    });
  }, []);

  const handleRetry = useCallback(() => {
    loadData(activeSelection);
  }, [loadData, activeSelection]);

  const isCustomRangeActive = activeSelection.kind === 'custom';

  return {
    activeSelection,
    activeRange,
    isCustomRangeActive,
    handleRangeSelect,
    handleCustomRangeSelect,
    isConfiguredForCurrentEntity,
    isLoadingCurrentEntity,
    errorForCurrentEntity,
    dataForCurrentEntity,
    loadData,
    handleRetry,
  };
}
