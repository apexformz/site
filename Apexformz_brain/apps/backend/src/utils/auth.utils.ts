import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import logger from './logger';

/**
 * Centrally manages JWT signing to avoid overload resolution issues and ensure type safety.
 */
export function signToken(
  payload: object, 
  secret: string, 
  options: SignOptions = {}
): string {
  if (!secret) {
    logger.error('JWT Secret is missing from environment variables');
    throw new Error('Server configuration error');
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

export function verifyToken(token: string, secret: string): any {
  if (!secret) {
    logger.error('JWT Secret for verification is missing');
    throw new Error('Server configuration error');
  }
  try {
    return jwt.verify(token, secret as Secret);
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      throw new Error('Token has expired');
    }
    if (err.name === 'JsonWebTokenError') {
      throw new Error('Token is malformed or signature is invalid');
    }
    throw new Error('Invalid token');
  }
}
