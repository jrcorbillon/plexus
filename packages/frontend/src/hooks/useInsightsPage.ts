import { useState, useEffect, useCallback, useRef } from 'react';
import type { ModelInsightRangeKey } from '../lib/model-insights';

export interface UseInsightsPageOptions<TData> {
  entityId: string;
  defaultRangeKey: ModelInsightRangeKey;
  checkIsConfigured: (entityId: string) => Promise<boolean>;
  fetchInsights: (entityId: string, range: ModelInsightRangeKey) => Promise<TData>;
}

export function useInsightsPage<TData>({
  entityId,
  defaultRangeKey,
  checkIsConfigured,
  fetchInsights,
}: UseInsightsPageOptions<TData>) {
  const [activeRange, setActiveRange] = useState<ModelInsightRangeKey>(defaultRangeKey);

  const [dataEntityId, setDataEntityId] = useState<string | null>(null);
  const [data, setData] = useState<TData | null>(null);

  const [errorEntityId, setErrorEntityId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [loadingEntityId, setLoadingEntityId] = useState<string | null>(entityId || null);

  const [configEntityId, setConfigEntityId] = useState<string | null>(null);
  const [isEntityConfigured, setIsEntityConfigured] = useState<boolean | null>(null);

  const fetchIdRef = useRef(0);
  const entityIdRef = useRef(entityId);

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
    async (range: ModelInsightRangeKey) => {
      if (!entityId) return;

      const fetchId = ++fetchIdRef.current;
      const entityForThisCall = entityId;
      setLoadingEntityId(entityForThisCall);
      setErrorEntityId(null);
      setError(null);

      try {
        const result = await fetchInsights(entityForThisCall, range);
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
    loadData(activeRange);
  }, [activeRange, loadData, isConfiguredForCurrentEntity, entityId]);

  const handleRangeSelect = (key: ModelInsightRangeKey) => {
    setActiveRange(key);
  };

  const handleRetry = () => {
    loadData(activeRange);
  };

  return {
    activeRange,
    handleRangeSelect,
    isConfiguredForCurrentEntity,
    isLoadingCurrentEntity,
    errorForCurrentEntity,
    dataForCurrentEntity,
    loadData,
    handleRetry,
  };
}
