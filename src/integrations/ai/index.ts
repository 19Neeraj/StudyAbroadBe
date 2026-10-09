/**
 * AI call analysis (spec §18–19, §52). Output is advisory: stored separately from the transcript,
 * labelled AI-generated, editable, and never used for automatic decisions.
 */
export interface CallInsights {
  summary: string;
  studentRequirements?: string;
  countryPreference?: string;
  coursePreference?: string;
  budget?: string;
  intake?: string;
  concerns: string[];
  objections: string[];
  nextAction?: string;
  recommendedFollowUp?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  intent: string[];
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  summarizeCall(input: { transcript: string; language?: string; context: { studentName?: string; counsellorName?: string } }): Promise<CallInsights>;
}

export const mockAi: AiProvider = {
  name: 'mock',
  model: 'mock-1',
  async summarizeCall({ transcript }) {
    const lower = transcript.toLowerCase();
    return {
      summary: 'Student is interested in a masters in data science in Germany.',
      countryPreference: lower.includes('germany') ? 'Germany' : undefined,
      coursePreference: lower.includes('data science') ? 'MSc Data Science' : undefined,
      budget: lower.includes('lakh') ? '₹20–25 lakh' : undefined,
      concerns: lower.includes('budget') ? ['Budget'] : [],
      objections: [],
      nextAction: 'Send university shortlist',
      recommendedFollowUp: 'Friday',
      sentiment: 'positive',
      intent: ['high_intent'],
    };
  },
};

const PROVIDERS: Record<string, AiProvider> = { mock: mockAi };

export function aiProvider(name: string | undefined): AiProvider | null {
  return name ? (PROVIDERS[name] ?? null) : null;
}
export function registerAiProvider(p: AiProvider): void {
  PROVIDERS[p.name] = p;
}
export const AI_PROVIDERS = () => Object.keys(PROVIDERS);
