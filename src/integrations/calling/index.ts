import { deviceProvider } from './device.provider.js';
import { exotelProvider } from './exotel.provider.js';
import { mockProvider } from './mock.provider.js';
import type { CallingProvider } from './calling.provider.js';

/** Registered calling providers. Add Twilio/FreJun/… here; nothing else in the CRM changes. */
const PROVIDERS: Record<string, CallingProvider> = {
  device: deviceProvider,
  exotel: exotelProvider,
  mock: mockProvider,
};

export const CALLING_PROVIDERS = Object.keys(PROVIDERS);

export function callingProvider(name: string): CallingProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown calling provider "${name}"`);
  return p;
}

export type { CallEvent, CallingProvider, CallStatus, CallDirection } from './calling.provider.js';
