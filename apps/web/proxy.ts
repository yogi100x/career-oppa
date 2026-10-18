import { clerkMiddleware } from '@clerk/nextjs/server';
import {
  NextResponse,
  type NextFetchEvent,
  type NextRequest,
} from 'next/server';
import { isClerkConfigured } from './lib/clerk-config';
import { sanitizeWorkspaceReturnPath } from './lib/workspace-return-path';

const clerkProxy = clerkMiddleware(async (auth, request) => {
  if (request.nextUrl.pathname === '/' && request.method === 'GET') {
    const { userId } = await auth();
    if (userId) return NextResponse.redirect(new URL('/workspace', request.url));
  }

  if (request.nextUrl.pathname.startsWith('/workspace')) {
    const signInUrl = new URL('/sign-in', request.url);
    signInUrl.searchParams.set(
      'redirect_url',
      sanitizeWorkspaceReturnPath(
        `${request.nextUrl.pathname}${request.nextUrl.search}`,
      ),
    );
    await auth.protect({
      unauthenticatedUrl: signInUrl.toString(),
    });
  }
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (
    request.method === 'OPTIONS' &&
    request.nextUrl.pathname.startsWith('/api/')
  ) {
    return NextResponse.next();
  }

  if (!isClerkConfigured()) {
    if (request.nextUrl.pathname.startsWith('/workspace')) {
      return NextResponse.redirect(new URL('/sign-in?setup=1', request.url));
    }

    return NextResponse.next();
  }

  return clerkProxy(request, event);
}

export const config = {
  matcher: [
    '/((?!_next|\\.well-known/workflow/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};
