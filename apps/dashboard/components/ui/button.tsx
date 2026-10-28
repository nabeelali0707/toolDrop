import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const VARIANTS = {
  default: 'bg-sky-700 text-white hover:bg-sky-800 dark:bg-sky-400 dark:text-slate-950 dark:hover:bg-sky-300',
  outline:
    'border border-slate-300 bg-transparent hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800',
  destructive:
    'bg-red-700 text-white hover:bg-red-800 dark:bg-red-500 dark:text-slate-950 dark:hover:bg-red-400',
  ghost: 'hover:bg-slate-100 dark:hover:bg-slate-800',
} as const;

export function Button({
  className,
  variant = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
