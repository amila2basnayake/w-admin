// Test environment for the voice suites. Imported FIRST so it runs before src/voice/config.ts (ES
// module imports are hoisted; assignments in the test file body would come too late).
process.env.AIADVISOR_VOICE_ENABLED = '1';
process.env.AIADVISOR_VOICE_WS_TOKEN = 'testtoken';
process.env.AIADVISOR_VOICE_TEST_CALLERS = '+61400111222:119063';
process.env.AIADVISOR_VOICE_TRANSFER_NUMBER = '+61812345678';
process.env.AIADVISOR_VOICE_TRANSFER_TO_BROKER = '0';
process.env.AIADVISOR_VOICE_OTP_TRANSPORT = 'console';
process.env.AIADVISOR_VOICE_OTP_DEV = '1';                            // console transport only delivers under the dev flag
process.env.AIADVISOR_VOICE_OTP_MAX_SENDS_PER_CLIENT_HOUR = '1000';   // the abuse cap would otherwise trip on repeated test runs
process.env.AIADVISOR_VOICE_KNOWLEDGE_MAX_ATTEMPTS_PER_CLIENT_HOUR = '1000';
process.env.AIADVISOR_VOICE_CALL_HOURS = '00:00-24:00';
process.env.AIADVISOR_VOICE_FILLER = '0';
process.env.RETELL_API_KEY = 'test_retell_key';
process.env.AIADVISOR_VOICE_DEMO = '0';
process.env.AIADVISOR_VOICE_OUTBOUND_WEBHOOK_SECRET = 'test_outbound_secret';
process.env.AIADVISOR_VOICE_WEBHOOK_TRUSTED_IPS = '';                 // signature only (the default)

process.env.AIADVISOR_VOICE_BACKEND = 'api';   // the scripted model replaces the Messages API client
export {};
