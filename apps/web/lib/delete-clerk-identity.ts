import 'server-only';
import { clerkClient } from '@clerk/nextjs/server';

export async function deleteClerkIdentity(clerkId: string): Promise<void> {
  try {
    await (await clerkClient()).users.deleteUser(clerkId);
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 404 || statusCode === 404) return;
    throw error;
  }
}
