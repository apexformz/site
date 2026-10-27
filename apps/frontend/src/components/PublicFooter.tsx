import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Brand } from './ui/Brand';

export function PublicFooter() {
  return (
    <footer className="border-t border-border/60 bg-surface/25">
      <div className="page-width py-12 sm:py-16">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Brand />
            <p className="mt-5 max-w-sm text-base leading-relaxed text-muted">
              A little more awareness. A better next session. Your personal
              sports coach, wherever you practice.
            </p>
          </div>
          <nav aria-label="Product links">
            <h2 className="mb-4 font-semibold">Discover ApexFormz</h2>
            <div className="flex flex-col items-start gap-3 text-sm text-muted">
              <Link href="/sports" className="hover:text-primary">
                Explore the sports
              </Link>
              <Link href="/technology" className="hover:text-primary">
                Inside the technology
              </Link>
              <Link href="/#how-it-works" className="hover:text-primary">
                How it works
              </Link>
            </div>
          </nav>
          <nav aria-label="Training links">
            <h2 className="mb-4 font-semibold">Make your next move</h2>
            <div className="flex flex-col items-start gap-3 text-sm text-muted">
              <Link
                href="/register"
                className="flex items-center gap-2 hover:text-primary"
              >
                Create your account <ArrowUpRight size={15} />
              </Link>
              <Link href="/login" className="hover:text-primary">
                Sign in to train
              </Link>
              <Link href="/dashboard" className="hover:text-primary">
                Your training space
              </Link>
            </div>
          </nav>
        </div>
        <div className="mt-12 flex flex-wrap justify-between gap-3 border-t border-border/50 pt-6 text-sm text-muted">
          <span>© {new Date().getFullYear()} ApexFormz</span>
          <span>Built around your movement.</span>
        </div>
      </div>
    </footer>
  );
}
