// Picks the model backend for a turn (see config.backend). ws.ts talks to this, never to a backend directly.
import { voiceConfig } from './config';
import { runTurn as runTurnApi, type TurnOptions } from './agent';
import { runTurnSdk } from './agent-sdk';
import type { VoiceSession } from './session';

export async function runVoiceTurn(session: VoiceSession, opts: TurnOptions): Promise<void> {
  if (voiceConfig.effectiveBackend === 'sdk') return runTurnSdk(session, opts);
  return runTurnApi(session, opts);
}
