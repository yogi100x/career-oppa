export type GetLeadsSearchInput = {
  companyName: string;
  role: string;
  limit?: number;
};

export type GetLeadsPerson = {
  providerContactId: string;
  providerProfileUrl: string | null;
  name: string;
  title: string;
  companyName: string;
  companyDomain: string | null;
  companyWebsite: string | null;
  emailStatus: 'VALID' | 'CATCH_ALL' | 'unknown';
  refreshedAt: Date | null;
};

export class GetLeadsError extends Error {
  constructor(
    public code: 'GETLEADS_NOT_CONFIGURED' | 'GETLEADS_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

type SearchOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
};

type RevealOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
};

const cleanString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function linkedinProfileUrl(value: unknown): string | null {
  const input = cleanString(value);
  if (!input) return null;
  try {
    const url = new URL(input.startsWith('http') ? input : `https://${input}`);
    if (
      url.protocol !== 'https:' ||
      !['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase()) ||
      !/^\/in\/[^/]+\/?$/i.test(url.pathname)
    )
      return null;
    url.hostname = 'www.linkedin.com';
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function parsePerson(value: unknown): GetLeadsPerson | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const providerContactId = cleanString(row.contact_id);
  const name =
    cleanString(row.full_name) ??
    [cleanString(row.first_name), cleanString(row.last_name)]
      .filter(Boolean)
      .join(' ');
  const companyName =
    cleanString(row.current_company_name) ?? cleanString(row.co_name);
  if (!providerContactId || !name || !companyName) return null;

  const emailStatus = cleanString(row.email_status);
  return {
    providerContactId,
    providerProfileUrl: linkedinProfileUrl(row.linkedin_url),
    name,
    title: cleanString(row.current_title) ?? '',
    companyName,
    companyDomain:
      cleanString(row.org_domain) ?? cleanString(row.company_domain),
    companyWebsite:
      cleanString(row.current_company_website) ??
      cleanString(row.current_employer_website),
    emailStatus:
      emailStatus === 'VALID' || emailStatus === 'CATCH_ALL'
        ? emailStatus
        : 'unknown',
    refreshedAt: dateOrNull(row.last_refresh_at),
  };
}

/** Search the documented GetLeads REST endpoint. Email values are never requested or returned. */
export async function searchGetLeadsContacts(
  input: GetLeadsSearchInput,
  options: SearchOptions = {},
): Promise<GetLeadsPerson[]> {
  const apiKey = options.apiKey ?? process.env.GETLEADS_API_KEY;
  if (!apiKey || apiKey.startsWith('REPLACE_WITH_'))
    throw new GetLeadsError(
      'GETLEADS_NOT_CONFIGURED',
      'GetLeads is not configured.',
    );

  const response = await (options.fetchImpl ?? fetch)(
    options.endpoint ?? 'https://app.getleads.io/api/v1/contacts/search',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        filters: {
          company_name: input.companyName,
          job_titles: [input.role],
        },
        columns: [
          'contact_id',
          'full_name',
          'first_name',
          'last_name',
          'current_title',
          'current_company_name',
          'current_company_website',
          'org_domain',
          'linkedin_url',
          'email_status',
          'last_refresh_at',
        ],
        limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
      }),
      signal: AbortSignal.timeout(90_000),
    },
  ).catch(() => {
    throw new GetLeadsError(
      'GETLEADS_UNAVAILABLE',
      'GetLeads could not complete this search.',
    );
  });

  if (!response.ok)
    throw new GetLeadsError(
      'GETLEADS_UNAVAILABLE',
      'GetLeads could not complete this search.',
    );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GetLeadsError(
      'GETLEADS_UNAVAILABLE',
      'GetLeads returned an unreadable response.',
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new GetLeadsError(
      'GETLEADS_UNAVAILABLE',
      'GetLeads returned an unreadable response.',
    );
  const rows = (payload as Record<string, unknown>).contacts;
  if (!Array.isArray(rows))
    throw new GetLeadsError(
      'GETLEADS_UNAVAILABLE',
      'GetLeads returned an unexpected response.',
    );
  return rows.flatMap((row) => {
    const contact = parsePerson(row);
    return contact ? [contact] : [];
  });
}

/** Resolve an email for a validated LinkedIn profile using the documented endpoint. */
export async function revealGetLeadsEmail(
  linkedinUrl: string,
  options: RevealOptions = {},
): Promise<{ email: string; emailStatus: 'VALID' | 'CATCH_ALL' | 'unknown' }> {
  const profileUrl = linkedinProfileUrl(linkedinUrl);
  if (!profileUrl)
    throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'This contact has no valid LinkedIn profile.');
  const apiKey = options.apiKey ?? process.env.GETLEADS_API_KEY;
  if (!apiKey || apiKey.startsWith('REPLACE_WITH_'))
    throw new GetLeadsError('GETLEADS_NOT_CONFIGURED', 'GetLeads is not configured.');
  const response = await (options.fetchImpl ?? fetch)(
    options.endpoint ?? 'https://app.getleads.io/api/v1/enrich/from-linkedin',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ items: [{ linkedin_url: profileUrl }], limit_per_item: 1 }),
      signal: AbortSignal.timeout(90_000),
    },
  ).catch(() => {
    throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'GetLeads could not reveal this contact.');
  });
  if (!response.ok)
    throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'GetLeads could not reveal this contact.');
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'GetLeads returned an unreadable response.');
  }
  const results =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).results
      : null;
  const result = Array.isArray(results) ? results[0] : null;
  if (!result || typeof result !== 'object' || Array.isArray(result) || (result as Record<string, unknown>).success !== true)
    throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'GetLeads did not find an email for this contact.');
  const row = result as Record<string, unknown>;
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? (row.data as Record<string, unknown>)
    : {};
  const email = cleanString(data.work_email) ?? cleanString(row.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'GetLeads did not find a usable email for this contact.');
  const status = cleanString(data.email_status);
  return {
    email: email.trim().normalize('NFC').toLowerCase(),
    emailStatus: status === 'VALID' || status === 'CATCH_ALL' ? status : 'unknown',
  };
}
