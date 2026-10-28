import type { InputHTMLAttributes, LabelHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-600',
        'focus-visible:outline-2 focus-visible:outline-sky-600',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 mt-3 block text-sm font-medium', className)} {...props} />;
}
