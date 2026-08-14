/**
 * Test environment.
 *
 * No third-party credentials are configured, so every test runs against the
 * in-memory store with dry run on. Nothing here can reach a live Readymode
 * account.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DRY_RUN = 'true';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.FRONTEND_URL = 'https://readysupport.test';
process.env.APPROVAL_TTL_SECONDS = '600';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.DISCORD_BOT_TOKEN;
delete process.env.OPENAI_API_KEY;
delete process.env.BROWSERBASE_API_KEY;
