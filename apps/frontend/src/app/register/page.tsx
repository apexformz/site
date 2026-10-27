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
  UserRound,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Sport } from '@smartcoach/types';
import { AuthFrame } from '@/components/AuthFrame';
import { AVAILABLE_SPORTS } from '@/lib/sports';

const sports = AVAILABLE_SPORTS.map((sport) => sport.id);

export default function RegisterPage() {
  const router = useRouter();
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    preferred_sport: 'squash' as Sport,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError('');
    try {
      const { data } = await api.post('/auth/register', formData);
      if (data.success && data.data) {
        localStorage.setItem('access_token', data.data.access_token);
        localStorage.setItem('refresh_token', data.data.refresh_token);
        router.push('/dashboard');
      } else
        setError(
          data.error || 'We could not create your account. Please try again.',
        );
    } catch (err: any) {
      setError(
        err.response?.data?.error ||
          (!err.response || err.response.status >= 500 ? 'The account service is unavailable. Please wait for the app services to start, then try again.' : 'Unable to create your account. Please try again.'),
      );
    } finally {
      setIsLoading(false);
    }
  };
  return (
    <AuthFrame mode="register">
      <form onSubmit={handleRegister} className="auth-form">
        <div className="auth-field">
          <label htmlFor="register-name">Your name</label>
          <div className="auth-input-wrap">
            <UserRound />
            <input
              id="register-name"
              name="name"
              autoComplete="name"
              type="text"
              className="auth-input"
              required
              minLength={2}
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder="Alex Rivera"
            />
          </div>
        </div>
        <div className="auth-field">
          <label htmlFor="register-email">Email address</label>
          <div className="auth-input-wrap">
            <Mail />
            <input
              id="register-email"
              name="email"
              autoComplete="email"
              type="email"
              className="auth-input"
              required
              value={formData.email}
              onChange={(e) =>
                setFormData({ ...formData, email: e.target.value })
              }
              placeholder="you@example.com"
            />
          </div>
        </div>
        <div className="auth-field">
          <label htmlFor="register-password">Password</label>
          <div className="auth-input-wrap">
            <LockKeyhole />
            <input
              id="register-password"
              name="password"
              autoComplete="new-password"
              className="auth-input"
              type={showPassword ? 'text' : 'password'}
              required
              minLength={8}
              value={formData.password}
              onChange={(e) =>
                setFormData({ ...formData, password: e.target.value })
              }
              placeholder="At least 8 characters"
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
        <fieldset className="auth-field">
          <legend className="mb-3">Primary discipline</legend>
          <div className="auth-sport-grid">
            {sports.map((sport) => (
              <button
                type="button"
                key={sport}
                className="auth-sport capitalize"
                aria-pressed={formData.preferred_sport === sport}
                onClick={() =>
                  setFormData({ ...formData, preferred_sport: sport })
                }
              >
                {sport}
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Squash uses the ApexFormz Brain for positions, strokes, and
            footwork. Technique criteria remain provisional.
          </p>
        </fieldset>
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
              <Loader2 size={17} className="auth-spinner" /> Creating your
              account…
            </>
          ) : (
            <>
              Create account <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
      <p className="auth-switch">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </AuthFrame>
  );
}
