import { Request, Response, NextFunction } from 'express';
import { ApiResponse } from '../types';
import { verifyToken } from '../utils/auth.utils';

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
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
    const payload = verifyToken(token, process.env.JWT_SECRET as string);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (err: any) {
    const response: ApiResponse<null> = { success: false, error: err.message.toUpperCase() };
    res.status(401).json(response);
  }
}
