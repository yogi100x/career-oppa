'use client';

import { SignIn, SignUp } from '@clerk/nextjs';

export default function AuthGate({
  mode,
  returnTo = '/workspace',
}: {
  mode: 'sign-in' | 'sign-up';
  returnTo?: string;
}) {
  const completionUrl = `/auth/complete?next=${encodeURIComponent(returnTo)}`;
  const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(returnTo)}`;
  const signUpUrl = `/sign-up?redirect_url=${encodeURIComponent(returnTo)}`;

  return (
    <section className="signup-consent">
      <h1>{mode === 'sign-up' ? 'Join Career-Oppa' : 'Welcome back'}</h1>
      {mode === 'sign-up' ? (
        <SignUp
          path="/sign-up"
          signInUrl={signInUrl}
          forceRedirectUrl={completionUrl}
          signInForceRedirectUrl={completionUrl}
        />
      ) : (
        <SignIn
          path="/sign-in"
          signUpUrl={signUpUrl}
          forceRedirectUrl={completionUrl}
          signUpForceRedirectUrl={completionUrl}
        />
      )}
    </section>
  );
}
