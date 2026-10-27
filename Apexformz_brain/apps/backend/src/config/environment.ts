/** Validate startup configuration without including secret values in diagnostics. */
export function validateEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.APEXFORMZ_S3_BUCKET) {
    if (!env.AWS_REGION || !/^\d{12}$/.test(env.APEXFORMZ_AWS_ACCOUNT_ID ?? '')) throw new Error('S3 requires an AWS region and expected account ID');
    if ((env.APEXFORMZ_SERVICE_TOKEN ?? '').length < 32) throw new Error('S3 analysis requires an internal service token of at least 32 characters');
  }
  const missing = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'].filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  let database: URL;
  try { database = new URL(env.DATABASE_URL!); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  if (env.NODE_ENV !== 'production') return;
  for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    if (env[key]!.length < 32 || /change.?me|your-super-secret|dev-only|example|placeholder/i.test(env[key]!)) {
      throw new Error(`${key} must be an independent production secret of at least 32 characters`);
    }
  }
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) throw new Error('Access and refresh token secrets must differ');
  if (!env.CORS_ORIGIN) throw new Error('CORS_ORIGIN is required in production');
  let origin: URL;
  try { origin = new URL(env.CORS_ORIGIN); } catch { throw new Error('CORS_ORIGIN must be one explicit HTTP(S) origin'); }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== env.CORS_ORIGIN || origin.username || origin.password) {
    throw new Error('CORS_ORIGIN must be one explicit HTTP(S) origin');
  }
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('CORS_ORIGIN must use HTTPS outside loopback development');
  }
}
