'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  Mail,
} from 'lucide-react';
import { api } from '@/lib/api';
import { AuthFrame } from '@/components/AuthFrame';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError('');
    try {
      const { data } = await api.post('/auth/login', { email, password });
      if (data.success && data.data) {
        localStorage.setItem('access_token', data.data.access_token);
        localStorage.setItem('refresh_token', data.data.refresh_token);
        router.push('/dashboard');
      } else
        setError(data.error || 'We could not sign you in. Please try again.');
    } catch (err: any) {
      setError(
        err.response?.data?.error ||
          'Unable to sign in. Check your details and try again.',
      );
    } finally {
      setIsLoading(false);
    }
  };
  return (
    <AuthFrame mode="login">
      <form onSubmit={handleLogin} className="auth-form">
        <div className="auth-field">
          <label htmlFor="login-email">Email address</label>
          <div className="auth-input-wrap">
            <Mail />
            <input
              id="login-email"
              name="email"
              autoComplete="email"
              className="auth-input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
        </div>
        <div className="auth-field">
          <label htmlFor="login-password">Password</label>
          <div className="auth-input-wrap">
            <LockKeyhole />
            <input
              id="login-password"
              name="password"
              autoComplete="current-password"
              className="auth-input"
              type={showPassword ? 'text' : 'password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
            />
            <button
              type="button"
              className="auth-password-toggle"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </div>
        {error && (
          <p
            role="alert"
            className="auth-error text-accent-danger border-accent-danger/20 bg-accent-danger/5"
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={isLoading}
          className="btn-primary auth-submit disabled:opacity-60"
          aria-busy={isLoading}
        >
          {isLoading ? (
            <>
              <Loader2 size={17} className="auth-spinner" /> Signing you in…
            </>
          ) : (
            <>
              Sign in <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
      <p className="auth-switch">
        New to ApexFormz? <Link href="/register">Create an account</Link>
      </p>
    </AuthFrame>
  );
}
