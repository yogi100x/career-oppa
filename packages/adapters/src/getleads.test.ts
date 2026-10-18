import { describe, expect, it, vi } from 'vitest';
import {
  GetLeadsError,
  revealGetLeadsEmail,
  searchGetLeadsContacts,
} from './getleads';

describe('GetLeads contact search adapter', () => {
  it('sends documented company and job-title filters and maps only safe contact fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        contacts: [
          {
            contact_id: 'provider-1',
            full_name: 'Jane Doe',
            current_title: 'Talent Partner',
            current_company_name: 'Example Co',
            org_domain: 'example.test',
            current_company_website: 'https://example.test',
            email_status: 'VALID',
            linkedin_url: 'https://www.linkedin.com/in/jane-doe',
            last_refresh_at: '2026-09-01T00:00:00.000Z',
            work_email: 'jane@example.test',
          },
        ],
      }),
    );

    await expect(
      searchGetLeadsContacts(
        { companyName: 'Example Co', role: 'Talent Partner' },
        { apiKey: 'recorded-test-key', fetchImpl },
      ),
    ).resolves.toEqual([
      {
        providerContactId: 'provider-1',
        providerProfileUrl: 'https://www.linkedin.com/in/jane-doe',
        name: 'Jane Doe',
        title: 'Talent Partner',
        companyName: 'Example Co',
        companyDomain: 'example.test',
        companyWebsite: 'https://example.test',
        emailStatus: 'VALID',
        refreshedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://app.getleads.io/api/v1/contacts/search');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer recorded-test-key',
    );
    const body = JSON.parse(String(init?.body));
    expect(body.filters).toEqual({
      company_name: 'Example Co',
      job_titles: ['Talent Partner'],
    });
    expect(body.columns).not.toContain('work_email');
    expect(body.limit).toBe(25);
  });

  it('refuses a missing or placeholder key without making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      searchGetLeadsContacts(
        { companyName: 'Example Co', role: 'Recruiter' },
        { apiKey: 'REPLACE_WITH_TEST_KEY', fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'GETLEADS_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid provider response instead of silently saving no contacts', async () => {
    await expect(
      searchGetLeadsContacts(
        { companyName: 'Example Co', role: 'Recruiter' },
        {
          apiKey: 'recorded-test-key',
          fetchImpl: vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json({ data: [] })),
        },
      ),
    ).rejects.toBeInstanceOf(GetLeadsError);
  });

  it('resolves an email only from the documented LinkedIn enrichment response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            success: true,
            linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
            data: { work_email: 'Jane@Example.test', email_status: 'VALID' },
          },
        ],
      }),
    );
    await expect(
      revealGetLeadsEmail('https://www.linkedin.com/in/jane-doe', {
        apiKey: 'recorded-test-key',
        fetchImpl,
      }),
    ).resolves.toEqual({
      email: 'jane@example.test',
      emailStatus: 'VALID',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://app.getleads.io/api/v1/enrich/from-linkedin');
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }],
      limit_per_item: 1,
    });
  });

  it('rejects arbitrary profile URLs before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      revealGetLeadsEmail('https://example.test/in/someone', {
        apiKey: 'recorded-test-key',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'GETLEADS_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
