'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  LayoutGrid,
  Activity,
  TrendingUp,
  Users,
  ChevronRight,
  UserRound,
} from 'lucide-react';
import { Brand } from './ui/Brand';
import { ThemeToggle } from './ui/ThemeProvider';
const navigation = [
  { id: 'overview', label: 'Overview', href: '/dashboard', icon: LayoutGrid },
  { id: 'training', label: 'Sports', href: '/sports', icon: Activity },
  { id: 'progress', label: 'Performance', href: '/profile', icon: TrendingUp },
  { id: 'circle', label: 'Circles', href: '/circles', icon: Users },
];
export function AppShell({
  children,
  userName,
  active = 'overview',
  title = 'Athlete overview',
}: {
  children: ReactNode;
  userName?: string;
  active?: 'overview' | 'training' | 'progress' | 'circle';
  title?: string;
}) {
  return (
    <div className="min-h-screen bg-background pb-28 xl:pb-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-6 focus:top-5 focus:z-50 focus:rounded-xl focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header className="app-header sticky top-0 z-40">
        <div className="page-width flex h-[92px] items-center justify-between gap-4 sm:h-[110px]">
          <Brand />
          <nav aria-label="Main navigation" className="nav-pill hidden xl:flex">
            {navigation.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active === item.id ? 'page' : undefined}
                className="!flex items-center gap-2"
              >
                <item.icon size={18} strokeWidth={1.7} />
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 sm:gap-5">
            <ThemeToggle />
            <Link
              href="/profile"
              aria-label="View your profile"
              className="flex items-center gap-3"
            >
              <span className="hidden max-w-32 truncate text-sm font-semibold text-muted md:block">
                {userName || 'My account'}
              </span>
              <span className="clay-icon !rounded-full h-11 w-11 text-base font-semibold sm:h-12 sm:w-12">
                {userName?.charAt(0)?.toUpperCase() || <UserRound size={19} />}
              </span>
            </Link>
          </div>
        </div>
      </header>
      <div className="page-width flex items-center gap-2 pt-7 text-[13px] text-subtle sm:pt-9 sm:text-sm">
        <span className="hidden sm:inline">Your workspace</span>
        <ChevronRight size={14} className="hidden sm:block" />
        <span>{title}</span>
      </div>
      <main
        id="main-content"
        className="page-width pb-10 pt-5 sm:pb-14 sm:pt-7"
      >
        {children}
      </main>
      <nav
        aria-label="Mobile navigation"
        className="mobile-nav fixed inset-x-3 bottom-3 z-50 grid grid-cols-4 gap-1 p-2 xl:hidden"
        style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {navigation.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active === item.id ? 'page' : undefined}
            className={`flex flex-col items-center gap-1.5 rounded-2xl px-1 py-3 text-xs font-semibold ${active === item.id ? 'bg-primary/10 text-primary' : 'text-muted'}`}
          >
            <item.icon size={21} strokeWidth={1.6} />
            {item.id === 'progress' ? 'Progress' : item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
