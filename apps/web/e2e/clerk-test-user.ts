/** Backend creation verifies this test email automatically; ticket sign-in needs no password. */
export function clerkTestUserParams(username: string) {
  if (!/^cw_(?:e2e|extension)_[a-z0-9_]+$/.test(username))
    throw new Error('Only dedicated browser test usernames are allowed.');
  return {
    username,
    emailAddress: [`${username}+clerk_test@example.com`],
    skipPasswordRequirement: true,
  };
}
