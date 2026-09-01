import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Sandbox working directory for every model call the Trainer makes: a dedicated EMPTY directory
 * (services/ai-advisor/trainer-workdir, gitignored) that holds no source, no settings and no .env.
 *
 * The repo's own .claude/settings.json grants Read, Write, Edit, Bash(git commit*) and Bash(cat*).
 * An agent constructed with default settingSources, or with a cwd inside the repo, would inherit
 * exactly the capabilities this system says the model does not have — writing src/ and personas/,
 * reading .env, committing. The isolation comes from the four options marked MANDATORY in
 * agent.ts, and test-trainer.ts asserts every one of them.
 */
const here = dirname(fileURLToPath(import.meta.url));   // src/trainer
export const TRAINER_SANDBOX_DIR = join(here, '..', '..', 'trainer-workdir');
mkdirSync(TRAINER_SANDBOX_DIR, { recursive: true });
