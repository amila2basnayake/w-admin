// Live itest environment: same as the protocol test but the model backend is real ('auto' = the
// Messages API when ANTHROPIC_API_KEY is set, else the Agent SDK on host credentials).
import './voice-test-env';
process.env.AIADVISOR_VOICE_BACKEND = 'auto';
export {};
