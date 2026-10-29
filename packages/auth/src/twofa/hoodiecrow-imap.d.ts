// Types for the IMAP test server the email-code tests run against; the package ships none.
declare module 'hoodiecrow-imap' {
  import type { AddressInfo } from 'node:net';

  interface IMAPServer {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: () => void): void;
    address(): AddressInfo;
  }

  export default function hoodiecrow(options?: Record<string, unknown>): IMAPServer;
}
