import { beforeEach } from 'vitest';
import { clearSecretRegistry } from '../src/security/redact.js';
import { clear as clearVault } from '../src/security/secretVault.js';

/**
 * Test environment.
 *
 * These are placeholder values, not credentials — nothing here can reach a
 * real service. Tests that need a real dependency mock it explicitly; nothing
 * in the suite touches Readymode, Browserbase, OpenAI or a live database.
 */

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';

process.env['DISCORD_BOT_TOKEN'] ??= 'test-discord-bot-token-value';
process.env['DISCORD_CLIENT_ID'] ??= '100000000000000001';
process.env['DISCORD_GUILD_ID'] ??= '100000000000000002';
process.env['DISCORD_NL_CHANNEL_ID'] ??= '100000000000000003';

process.env['SUPABASE_URL'] ??= 'https://example.supabase.test';
process.env['SUPABASE_SERVICE_ROLE_KEY'] ??= 'test-service-role-key-value';

process.env['OPENAI_API_KEY'] ??= 'test-openai-key-value';
process.env['BROWSERBASE_API_KEY'] ??= 'test-browserbase-key-value';
process.env['BROWSERBASE_PROJECT_ID'] ??= 'test-project';
process.env['BROWSERBASE_CONTEXT_ID'] ??= 'test-context';

process.env['READYMODE_LOGIN_URL'] ??= 'http://127.0.0.1:9/login';
process.env['READYMODE_ADMIN_USERNAME'] ??= 'admin';
process.env['READYMODE_ADMIN_PASSWORD'] ??= 'correct-horse-battery';

// A throwaway 32-byte key.
process.env['ENCRYPTION_KEY'] ??= Buffer.alloc(32, 7).toString('base64');

process.env['READYSUPPORT_MODE'] ??= 'live';
process.env['READYMODE_DRIVER'] ??= 'mock';
process.env['ENABLE_CREATE_ACCOUNT'] ??= 'true';
process.env['ENABLE_CLEAR_LICENSE'] ??= 'true';
process.env['ENABLE_RESET_PASSWORD'] ??= 'true';
process.env['ENABLE_DEACTIVATE_ACCOUNT'] ??= 'true';

// Point the overlay at a path that does not exist, so the default registry
// stays fully UNKNOWN unless a test installs one deliberately.
process.env['READYMODE_SELECTOR_OVERLAY'] ??= 'config/does-not-exist.json';

beforeEach(() => {
  // Secrets are process-global, so leaving one registered would let a
  // redaction test pass because of something an earlier test did.
  clearSecretRegistry();
  clearVault();
});
