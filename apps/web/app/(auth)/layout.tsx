import { ClerkProvider } from '@clerk/nextjs';
import { isClerkConfigured } from '../../lib/clerk-config';
import './auth.css';

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return isClerkConfigured() ? (
    <ClerkProvider>{children}</ClerkProvider>
  ) : (
    children
  );
}
