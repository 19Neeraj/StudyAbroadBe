import type { CallingProvider } from './calling.provider.js';

/** No telephony provider: the phone app dials natively and reports the outcome itself. */
export const deviceProvider: CallingProvider = {
  name: 'device',
  family: 'device',
  async makeCall() {
    return { providerCallId: '', status: 'initiated' };
  },
  parseWebhook() {
    return [];
  },
};
