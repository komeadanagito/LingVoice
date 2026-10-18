export type ProviderCapability = 'translation' | 'asr' | 'models';

export interface Provider {
  id: string;
  name: string;
  adapter: string;
  baseUrl: string;
  hasApiKey: boolean;
}

export interface ProviderUpdate {
  id?: string;
  name: string;
  adapter: string;
  baseUrl: string;
  /** Omit to retain the saved key; an empty string clears it. */
  apiKey?: string;
}

export interface ProviderAdapterInfo {
  id: string;
  name: string;
  capabilities: ProviderCapability[];
  defaultBaseUrl: string;
  /** UI hints are supplied by the adapter, not inferred from its identifier. */
  translationOptions?: { model: boolean; protocols: string[] };
}

export interface ProviderCatalog {
  providers: Provider[];
  adapters: ProviderAdapterInfo[];
}
