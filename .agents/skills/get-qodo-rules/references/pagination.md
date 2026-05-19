# Fetching Rules with Pagination

The API returns rules in pages of 50. All pages must be fetched to ensure no rules are missed.

## Algorithm

1. Start with `page=1`, `page_size=50`, accumulate results in an empty list
2. Request: `GET {API_URL}/rules?scopes={ENCODED_SCOPE}&state=active&page={PAGE}&page_size=50`
   - Header: `Authorization: Bearer {API_KEY}`
3. On non-200 response, handle the error and exit gracefully:
   - `401` — invalid/expired API key
   - `403` — access forbidden
   - `404` — endpoint not found (check `QODO_ENVIRONMENT_NAME`)
   - `429` — rate limit exceeded
   - `5xx` — API temporarily unavailable
   - connection error — check internet connection
4. Parse `rules` array from JSON response body
5. Append page rules to accumulated list
6. If rules returned on this page < 50 → last page, stop
7. Otherwise increment page and repeat from step 2
8. Safety limit: stop after 100 pages (5000 rules max)

## API URL

Construct `{API_URL}` from `ENVIRONMENT_NAME` (read from `~/.qodo/config.json`):

| `ENVIRONMENT_NAME` | `{API_URL}` |
|---|---|
| set (e.g. `staging`) | `https://qodo-platform.staging.qodo.ai/rules/v1` |

## After Fetching

If total rules == 0, inform the user no rules are configured for the repository scope and exit gracefully.
