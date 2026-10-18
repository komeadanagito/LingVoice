import type { LingVoiceApi } from '../shared/contracts';

declare global {
  interface Window { lingvoice: LingVoiceApi }
}
export {};
