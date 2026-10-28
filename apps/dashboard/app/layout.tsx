import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '../components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'toolDrop',
  description: 'Your tools, their runs, the writes waiting for approval, and your saved logins.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
