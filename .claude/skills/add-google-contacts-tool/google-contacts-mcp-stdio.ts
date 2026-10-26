/**
 * Google Contacts MCP Server for NanoClaw
 *
 * Exposes the Google People API (https://people.googleapis.com) as tools for the
 * container agent: list / search / get / create / update / delete contacts, plus
 * "other contacts" (auto-saved people you've emailed but not added).
 *
 * Auth is handled by the OneCLI gateway, NOT by this server. The gateway intercepts
 * outbound calls to people.googleapis.com and replaces the Authorization header with
 * the real OAuth bearer from its vault (see container/skills/onecli-gateway). This
 * server therefore sends only a placeholder bearer and relies on the container's
 * injected HTTPS_PROXY + CA trust — exactly the same pattern the gmail/gcal tools use.
 * No raw credentials ever reach the container.
 *
 * Requires the `google-contacts` provider to be connected in OneCLI.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PEOPLE_API_BASE =
  process.env.GOOGLE_CONTACTS_API_BASE || 'https://people.googleapis.com/v1';

// The OneCLI gateway overwrites this header with the real vault token. It is only a
// placeholder so the request is well-formed before it reaches the proxy.
const STUB_BEARER = process.env.GOOGLE_CONTACTS_BEARER || 'onecli-managed';

// Fields requested when reading a full contact.
const DEFAULT_PERSON_FIELDS =
  'names,emailAddresses,phoneNumbers,organizations,addresses,biographies,memberships,metadata';
// Lighter mask for list/search result rows.
const DEFAULT_READ_MASK = 'names,emailAddresses,phoneNumbers,organizations';

function log(msg: string): void {
  console.error(`[GCONTACTS] ${msg}`);
}

interface Person {
  resourceName?: string;
  etag?: string;
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>;
  emailAddresses?: Array<{ value?: string; type?: string }>;
  phoneNumbers?: Array<{ value?: string; type?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
  addresses?: Array<{ formattedValue?: string; type?: string }>;
  biographies?: Array<{ value?: string }>;
}

async function peopleFetch(
  apiPath: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = apiPath.startsWith('http')
    ? apiPath
    : `${PEOPLE_API_BASE}${apiPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STUB_BEARER}`,
    Accept: 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  return fetch(url, { ...options, headers });
}

/** Turn a non-2xx People API response into a helpful agent-facing error string. */
async function apiError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body?.error?.message ? ` — ${body.error.message}` : '';
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401 || res.status === 403) {
    return (
      `Google People API returned ${res.status}${detail}. ` +
      `The OneCLI gateway could not inject a valid token. Check that the ` +
      `\`google-contacts\` provider is connected in OneCLI (http://127.0.0.1:10254 → ` +
      `Apps → Google Contacts) and that this agent's secret mode includes it.`
    );
  }
  return `Google People API error ${res.status}${detail}`;
}

function fmtPerson(p: Person): string {
  const name = p.names?.[0]?.displayName || '(no name)';
  const emails = (p.emailAddresses || [])
    .map((e) => e.value)
    .filter(Boolean)
    .join(', ');
  const phones = (p.phoneNumbers || [])
    .map((ph) => ph.value)
    .filter(Boolean)
    .join(', ');
  const org = p.organizations?.[0];
  const orgStr = org ? [org.title, org.name].filter(Boolean).join(' @ ') : '';
  const lines = [`• ${name}`];
  if (emails) lines.push(`    email: ${emails}`);
  if (phones) lines.push(`    phone: ${phones}`);
  if (orgStr) lines.push(`    org:   ${orgStr}`);
  if (p.resourceName) lines.push(`    id:    ${p.resourceName}`);
  return lines.join('\n');
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

const server = new McpServer({ name: 'google_contacts', version: '1.0.0' });

server.tool(
  'list_contacts',
  "List the user's saved Google Contacts (their 'connections'). Returns name, email, phone, org, and the resourceName id needed for get/update/delete.",
  {
    page_size: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Max contacts to return (default 50, max 1000).'),
  },
  async (args) => {
    const pageSize = args.page_size ?? 50;
    log(`list_contacts pageSize=${pageSize}`);
    try {
      const qs = new URLSearchParams({
        personFields: DEFAULT_READ_MASK,
        pageSize: String(pageSize),
        sortOrder: 'LAST_MODIFIED_DESCENDING',
      });
      const res = await peopleFetch(`/people/me/connections?${qs}`);
      if (!res.ok) return textResult(await apiError(res), true);
      const data = (await res.json()) as {
        connections?: Person[];
        totalpeople?: number;
      };
      const people = data.connections || [];
      if (people.length === 0) return textResult('No contacts found.');
      return textResult(
        `${people.length} contact(s):\n\n${people.map(fmtPerson).join('\n')}`,
      );
    } catch (err) {
      return textResult(`Failed to list contacts: ${errMsg(err)}`, true);
    }
  },
);

server.tool(
  'search_contacts',
  "Search the user's saved contacts by name, email, or phone. Returns matching contacts with their resourceName ids.",
  {
    query: z.string().min(1).describe('Search text (name, email, or phone).'),
    page_size: z.number().int().min(1).max(30).optional(),
  },
  async (args) => {
    const pageSize = args.page_size ?? 15;
    log(`search_contacts query=${JSON.stringify(args.query)}`);
    try {
      // People API recommends a warmup request (empty query) before searching so the
      // server-side cache is primed; results can be empty otherwise on the first call.
      await peopleFetch(
        `/people:searchContacts?${new URLSearchParams({ query: '', readMask: DEFAULT_READ_MASK })}`,
      ).catch(() => undefined);

      const qs = new URLSearchParams({
        query: args.query,
        readMask: DEFAULT_READ_MASK,
        pageSize: String(pageSize),
      });
      const res = await peopleFetch(`/people:searchContacts?${qs}`);
      if (!res.ok) return textResult(await apiError(res), true);
      const data = (await res.json()) as { results?: Array<{ person?: Person }> };
      const people = (data.results || [])
        .map((r) => r.person)
        .filter((p): p is Person => Boolean(p));
      if (people.length === 0)
        return textResult(`No contacts matched "${args.query}".`);
      return textResult(
        `${people.length} match(es) for "${args.query}":\n\n${people.map(fmtPerson).join('\n')}`,
      );
    } catch (err) {
      return textResult(`Failed to search contacts: ${errMsg(err)}`, true);
    }
  },
);

server.tool(
  'search_other_contacts',
  "Search 'other contacts' — people the user has interacted with (e.g. emailed) but not explicitly saved. Useful when someone isn't in the main contact list.",
  {
    query: z.string().min(1).describe('Search text (name or email).'),
    page_size: z.number().int().min(1).max(30).optional(),
  },
  async (args) => {
    const pageSize = args.page_size ?? 15;
    log(`search_other_contacts query=${JSON.stringify(args.query)}`);
    try {
      const readMask = 'names,emailAddresses,phoneNumbers';
      await peopleFetch(
        `/otherContacts:search?${new URLSearchParams({ query: '', readMask })}`,
      ).catch(() => undefined);
      const qs = new URLSearchParams({
        query: args.query,
        readMask,
        pageSize: String(pageSize),
      });
      const res = await peopleFetch(`/otherContacts:search?${qs}`);
      if (!res.ok) return textResult(await apiError(res), true);
      const data = (await res.json()) as { results?: Array<{ person?: Person }> };
      const people = (data.results || [])
        .map((r) => r.person)
        .filter((p): p is Person => Boolean(p));
      if (people.length === 0)
        return textResult(`No other contacts matched "${args.query}".`);
      return textResult(
        `${people.length} other-contact match(es):\n\n${people.map(fmtPerson).join('\n')}`,
      );
    } catch (err) {
      return textResult(`Failed to search other contacts: ${errMsg(err)}`, true);
    }
  },
);

server.tool(
  'get_contact',
  'Get full details for a single contact by its resourceName (e.g. "people/c12345"). Use list_contacts or search_contacts first to find the id.',
  {
    resource_name: z
      .string()
      .min(1)
      .describe('The contact resourceName, e.g. "people/c1234567890".'),
  },
  async (args) => {
    log(`get_contact ${args.resource_name}`);
    try {
      const qs = new URLSearchParams({ personFields: DEFAULT_PERSON_FIELDS });
      const res = await peopleFetch(
        `/${encodeURI(args.resource_name)}?${qs}`,
      );
      if (!res.ok) return textResult(await apiError(res), true);
      const p = (await res.json()) as Person;
      const bio = p.biographies?.[0]?.value;
      const addr = (p.addresses || [])
        .map((a) => a.formattedValue)
        .filter(Boolean)
        .join(' | ');
      let out = fmtPerson(p);
      if (addr) out += `\n    address: ${addr}`;
      if (bio) out += `\n    notes: ${bio}`;
      if (p.etag) out += `\n    etag:  ${p.etag}`;
      return textResult(out);
    } catch (err) {
      return textResult(`Failed to get contact: ${errMsg(err)}`, true);
    }
  },
);

const ContactFields = {
  given_name: z.string().optional().describe('First name.'),
  family_name: z.string().optional().describe('Last name.'),
  emails: z
    .array(z.string())
    .optional()
    .describe('Email addresses.'),
  phones: z
    .array(z.string())
    .optional()
    .describe('Phone numbers.'),
  organization: z.string().optional().describe('Company / organization name.'),
  job_title: z.string().optional().describe('Job title.'),
  notes: z.string().optional().describe('Freeform notes / biography.'),
};

type ContactArgs = {
  given_name?: string;
  family_name?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  job_title?: string;
  notes?: string;
};

/** Build a People API person body from the flat tool args; returns the set field paths too. */
function buildPersonBody(args: ContactArgs): {
  body: Record<string, unknown>;
  fields: string[];
} {
  const body: Record<string, unknown> = {};
  const fields: string[] = [];
  if (args.given_name !== undefined || args.family_name !== undefined) {
    body.names = [
      { givenName: args.given_name, familyName: args.family_name },
    ];
    fields.push('names');
  }
  if (args.emails) {
    body.emailAddresses = args.emails.map((value) => ({ value }));
    fields.push('emailAddresses');
  }
  if (args.phones) {
    body.phoneNumbers = args.phones.map((value) => ({ value }));
    fields.push('phoneNumbers');
  }
  if (args.organization !== undefined || args.job_title !== undefined) {
    body.organizations = [
      { name: args.organization, title: args.job_title },
    ];
    fields.push('organizations');
  }
  if (args.notes !== undefined) {
    body.biographies = [{ value: args.notes, contentType: 'TEXT_PLAIN' }];
    fields.push('biographies');
  }
  return { body, fields };
}

server.tool(
  'create_contact',
  'Create a new contact in the user\'s Google Contacts. Provide at least a name or an email.',
  ContactFields,
  async (args) => {
    log(`create_contact ${args.given_name ?? ''} ${args.family_name ?? ''}`);
    const { body, fields } = buildPersonBody(args);
    if (fields.length === 0)
      return textResult(
        'Nothing to create — provide at least a name, email, or phone.',
        true,
      );
    try {
      const res = await peopleFetch('/people:createContact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return textResult(await apiError(res), true);
      const p = (await res.json()) as Person;
      return textResult(`Created contact:\n${fmtPerson(p)}`);
    } catch (err) {
      return textResult(`Failed to create contact: ${errMsg(err)}`, true);
    }
  },
);

server.tool(
  'update_contact',
  'Update fields on an existing contact (by resourceName). Only the fields you pass are changed. Fetches the current etag automatically.',
  { resource_name: z.string().min(1), ...ContactFields },
  async (args) => {
    const { resource_name, ...rest } = args;
    log(`update_contact ${resource_name}`);
    const { body, fields } = buildPersonBody(rest);
    if (fields.length === 0)
      return textResult('Nothing to update — provide at least one field.', true);
    try {
      // Fetch current etag (required by updateContact to avoid lost updates).
      const cur = await peopleFetch(
        `/${encodeURI(resource_name)}?personFields=metadata`,
      );
      if (!cur.ok) return textResult(await apiError(cur), true);
      const { etag } = (await cur.json()) as Person;

      const qs = new URLSearchParams({ updatePersonFields: fields.join(',') });
      const res = await peopleFetch(
        `/${encodeURI(resource_name)}:updateContact?${qs}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ etag, ...body }),
        },
      );
      if (!res.ok) return textResult(await apiError(res), true);
      const p = (await res.json()) as Person;
      return textResult(`Updated contact:\n${fmtPerson(p)}`);
    } catch (err) {
      return textResult(`Failed to update contact: ${errMsg(err)}`, true);
    }
  },
);

server.tool(
  'delete_contact',
  'Delete a contact by its resourceName (e.g. "people/c12345"). This is permanent.',
  { resource_name: z.string().min(1) },
  async (args) => {
    log(`delete_contact ${args.resource_name}`);
    try {
      const res = await peopleFetch(
        `/${encodeURI(args.resource_name)}:deleteContact`,
        { method: 'DELETE' },
      );
      if (!res.ok) return textResult(await apiError(res), true);
      return textResult(`Deleted contact ${args.resource_name}.`);
    } catch (err) {
      return textResult(`Failed to delete contact: ${errMsg(err)}`, true);
    }
  },
);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const transport = new StdioServerTransport();
await server.connect(transport);
log('Google Contacts MCP server started');
