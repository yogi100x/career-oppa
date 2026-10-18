const DEFAULT_WORKSPACE_PATH = '/workspace';
const BASE_URL = 'http://career-workspace.local';

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** Keep Clerk's return URL on this site and inside the signed-in workspace. */
export function sanitizeWorkspaceReturnPath(
  value: string | string[] | undefined,
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    !candidate ||
    hasControlCharacters(candidate) ||
    candidate.includes('\\') ||
    candidate.startsWith('//') ||
    !candidate.startsWith('/')
  )
    return DEFAULT_WORKSPACE_PATH;

  try {
    const url = new URL(candidate, BASE_URL);

    // URL normalizes literal and encoded dot segments, so inspect the raw path
    // first and reject them instead of accepting a subtly changed destination.
    const rawPath = candidate.split(/[?#]/, 1)[0];
    const segments = rawPath.split('/');
    for (const segment of segments) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return DEFAULT_WORKSPACE_PATH;
      }
      if (
        decoded === '.' ||
        decoded === '..' ||
        hasControlCharacters(decoded) ||
        decoded.includes('\\') ||
        decoded.includes('/')
      )
        return DEFAULT_WORKSPACE_PATH;
    }

    if (
      url.pathname !== '/workspace' &&
      !url.pathname.startsWith('/workspace/')
    )
      return DEFAULT_WORKSPACE_PATH;
    return `${url.pathname}${url.search}`;
  } catch {
    return DEFAULT_WORKSPACE_PATH;
  }
}
