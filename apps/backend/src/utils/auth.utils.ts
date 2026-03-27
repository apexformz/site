import jwt, { Secret, SignOptions } from 'jsonwebtoken';

/**
 * Centrally manages JWT signing to avoid overload resolution issues and ensure type safety.
 */
export function signToken(
  payload: object, 
  secret: string, 
  options: SignOptions = {}
): string {
  if (!secret) {
    throw new Error('JWT Secret is missing from environment variables');
  }
  return jwt.sign(payload, secret as Secret, options);
}

export function generateAuthTokens(userId: string, email: string) {
  const access_token = signToken(
    { userId, email },
    process.env.JWT_SECRET as string,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as SignOptions['expiresIn'] }
  );
  
  const refresh_token = signToken(
    { userId, email },
    process.env.JWT_REFRESH_SECRET as string,
    { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as SignOptions['expiresIn'] }
  );
  
  return { access_token, refresh_token };
}
