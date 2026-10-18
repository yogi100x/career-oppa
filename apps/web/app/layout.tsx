import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Career-Oppa — The student pilot is open',
  description: 'You’ve got a lot to offer. Career-Oppa helps you find your strengths, prepare applications and take your next step. The pilot is open to invited students. Sign in with your invited Google account, or talk to the founder for an invite.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
