// Env for the PBX pull scripts. Imported FIRST so it runs before dotenv and src/call-notes/config.ts
// (imports are hoisted; assignments in the script body come too late). Read the CRM's own
// phone_system_settings and go through the Hetzner proxy tunnel to the whitelisted portal.
process.env.AIADVISOR_PBX_SOURCE = 'db';
process.env.AIADVISOR_PBX_PROXY = process.env.AIADVISOR_PBX_PROXY || 'http://127.0.0.1:9446';
process.env.AIADVISOR_SPEND_LEDGER = process.env.AIADVISOR_SPEND_LEDGER || '0';
export {};
