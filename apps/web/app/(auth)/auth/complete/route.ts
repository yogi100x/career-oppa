import { auth } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { sanitizeWorkspaceReturnPath } from '../../../../lib/workspace-return-path';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const returnTo = sanitizeWorkspaceReturnPath(
    request.nextUrl.searchParams.get('next') ?? undefined,
  );
  const { userId } = await auth();
  if (!userId) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('redirect_url', returnTo);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.redirect(new URL(returnTo, request.url));
}
