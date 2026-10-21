import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderCatalog } from '../../shared/providers';

export interface ProviderModelsEntry {
  models: string[];
  loading: boolean;
  error: string;
  loaded: boolean;
}

interface CachedEntry extends ProviderModelsEntry {
  signature: string;
}
interface PendingRequest {
  signature: string;
  promise: Promise<void>;
}

/** One instance can share discovery results across all task model pickers. */
export function useProviderModels(catalog: ProviderCatalog) {
  const signatures: Record<string, string> = Object.fromEntries(catalog.providers.map(provider => [
    provider.id,
    JSON.stringify([provider.id, provider.name, provider.adapter, provider.baseUrl, provider.hasApiKey]),
  ]));
  const signaturesRef = useRef(signatures);
  signaturesRef.current = signatures;
  const mounted = useRef(false);
  const pending = useRef(new Map<string, PendingRequest>());
  const [cache, setCache] = useState<Record<string, CachedEntry>>({});
  const catalogSignature = JSON.stringify(signatures);

  useEffect(() => {
    mounted.current = true;
    // StrictMode may have disposed requests during its simulated unmount.
    setCache(previous => Object.fromEntries(Object.entries(previous).map(([id, entry]) => [
      id, entry.loading && !pending.current.has(id) ? { ...entry, loading: false } : entry,
    ])));
    return () => {
      mounted.current = false;
      pending.current.clear();
    };
  }, []);

  useEffect(() => {
    for (const [id, request] of pending.current) {
      if (signaturesRef.current[id] !== request.signature) pending.current.delete(id);
    }
    setCache(previous => {
      const valid = Object.entries(previous).filter(([id, entry]) => signaturesRef.current[id] === entry.signature);
      return valid.length === Object.keys(previous).length ? previous : Object.fromEntries(valid);
    });
  }, [catalogSignature]);

  const invalidate = useCallback((providerId?: string) => {
    if (providerId === undefined) pending.current.clear();
    else pending.current.delete(providerId);
    if (!mounted.current) return;
    setCache(previous => {
      if (providerId === undefined) return {};
      const next = { ...previous };
      delete next[providerId];
      return next;
    });
  }, []);

  const fetchModels = useCallback((providerId: string): Promise<void> => {
    const signature = signaturesRef.current[providerId];
    if (!mounted.current || !signature) return Promise.resolve();
    const existing = pending.current.get(providerId);
    if (existing?.signature === signature) return existing.promise;

    const request: PendingRequest = { signature, promise: Promise.resolve() };
    const isCurrent = () => mounted.current
      && signaturesRef.current[providerId] === signature
      && pending.current.get(providerId) === request;
    setCache(previous => {
      const old = previous[providerId]?.signature === signature ? previous[providerId] : undefined;
      return { ...previous, [providerId]: {
        signature, models: old?.models ?? [], loaded: old?.loaded ?? false, loading: true, error: '',
      } };
    });
    pending.current.set(providerId, request);
    request.promise = Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) return;
        const result = await window.lingvoice.providerModels(providerId);
        if (!isCurrent()) return;
        if (!result.ok) throw new Error(result.error);
        const models = [...new Set(result.data.filter(model => typeof model === 'string' && model.length > 0))];
        setCache(previous => ({ ...previous, [providerId]: {
          signature, models, loaded: true, loading: false, error: '',
        } }));
      } catch (error) {
        if (!isCurrent()) return;
        setCache(previous => ({ ...previous, [providerId]: {
          signature,
          models: previous[providerId]?.models ?? [],
          loaded: previous[providerId]?.loaded ?? false,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        } }));
      } finally {
        if (pending.current.get(providerId) === request) pending.current.delete(providerId);
      }
    });
    return request.promise;
  }, []);

  const entries: Record<string, ProviderModelsEntry> = Object.fromEntries(
    Object.entries(cache)
      .filter(([id, entry]) => signatures[id] === entry.signature)
      .map(([id, { signature: _signature, ...entry }]) => [id, entry]),
  );
  return { entries, fetchModels, invalidate };
}
