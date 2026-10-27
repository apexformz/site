'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { Brand } from './ui/Brand';
import { ThemeToggle } from './ui/ThemeProvider';
const navigation = [
  { href: '/', label: 'Home' },
  { href: '/sports', label: 'Sports' },
  { href: '/technology', label: 'Technology' },
];
export function PublicHeader() {
  const pathname = usePathname();
  return (
    <header className="app-header relative z-30">
      <div className="page-width flex h-[92px] items-center justify-between gap-5 sm:h-[110px]">
        <Brand />
        <nav aria-label="Main navigation" className="nav-pill hidden lg:flex">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4 sm:gap-6">
          <ThemeToggle />
          <Link
            href="/login"
            className="hidden text-[15px] font-semibold text-muted hover:text-foreground xl:block"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="btn-primary hidden !px-6 !text-[15px] sm:inline-flex"
          >
            Get started <ArrowUpRight size={18} />
          </Link>
        </div>
      </div>
      <nav
        aria-label="Mobile navigation"
        className="page-width grid grid-cols-4 gap-1 border-t border-border/40 py-2 lg:hidden"
      >
        {[...navigation, { href: '/login', label: 'Sign in' }].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname === item.href ? 'page' : undefined}
            className={`rounded-xl py-3 text-center text-[13px] font-semibold sm:text-sm ${pathname === item.href ? 'bg-surface text-primary shadow-sm' : 'text-muted'}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
