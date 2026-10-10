/** Push delivery (mobile spec §33). The notification centre stores everything; push is best-effort. */
export interface PushMessage {
  title: string;
  body: string;
  /** Flat string map: the app reads leadId / studentId / type to open the right screen. */
  data: Record<string, string>;
  badge?: number;
}

export interface PushResult {
  ok: boolean;
  /** The token is no longer valid (app uninstalled, token rotated): stop using it. */
  invalidToken?: boolean;
  error?: string;
}

export interface PushProvider {
  readonly name: string;
  send(token: string, platform: 'android' | 'ios' | 'web', message: PushMessage): Promise<PushResult>;
}
