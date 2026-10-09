/**
 * Speech-to-text abstraction (spec §16–17). Languages come from the organization policy
 * (e.g. en-IN, hi-IN, or "auto" for Hinglish detection) — nothing is hardcoded.
 * Real providers (Deepgram, AssemblyAI, Google STT, Whisper…) implement this interface.
 */
export interface TranscriptionResult {
  language: string;
  duration?: number;
  segments: { speaker: string; startTime: number; endTime: number; text: string }[];
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: { body: Buffer; contentType: string }, opts: { languages: string[] }): Promise<TranscriptionResult>;
}

/** Deterministic transcript for tests/demos. */
export const mockTranscription: TranscriptionProvider = {
  name: 'mock',
  async transcribe(_audio, opts) {
    return {
      language: opts.languages[0] ?? 'en-IN',
      duration: 42,
      segments: [
        { speaker: 'Counsellor', startTime: 0, endTime: 5, text: 'Which country are you interested in?' },
        { speaker: 'Student', startTime: 5, endTime: 12, text: 'Mainly Germany, for a masters in data science. My budget is around 20 to 25 lakh.' },
        { speaker: 'Counsellor', startTime: 12, endTime: 20, text: 'Great, I will send you a university shortlist and we can talk again on Friday.' },
      ],
    };
  },
};

const PROVIDERS: Record<string, TranscriptionProvider> = { mock: mockTranscription };

export function transcriptionProvider(name: string | undefined): TranscriptionProvider | null {
  return name ? (PROVIDERS[name] ?? null) : null;
}
export const TRANSCRIPTION_PROVIDERS = Object.keys(PROVIDERS);
