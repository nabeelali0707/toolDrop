import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names, the later Tailwind class winning a conflict (shadcn/ui's helper). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** A short local date and time. */
export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}
