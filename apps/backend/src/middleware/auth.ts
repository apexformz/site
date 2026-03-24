import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiResponse } from '@smartcoach/types';

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

interface JwtPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    const response: ApiResponse<null> = { success: false, error: 'Access token required' };
    res.status(401).json(response);
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    const response: ApiResponse<null> = { success: false, error: 'Invalid or expired token' };
    res.status(401).json(response);
  }
}
