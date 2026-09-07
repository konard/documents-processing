// gmail-lib.mjs — programmatic Gmail access (OAuth2 entirely in code).
//
// No personal data lives here: OAuth client credentials and the issued token are
// read from the environment / a .env file / the data/ folder, never hardcoded.
//
// Credential sources, in order:
//   1. env vars  GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET  (optionally GMAIL_REDIRECT_URI)
//   2. a .env file in the base dir (same keys)
//   3. data/gmail-credentials.json  — a Google Cloud "Desktop app" OAuth client
//      ({ "installed": { "client_id", "client_secret", "redirect_uris" } } or a
//       flat { "client_id", "client_secret" }).
//
// The issued token is cached at data/gmail-token.json and refreshed silently.
// Read-only scope (gmail.readonly) is requested — this library never modifies
// the mailbox.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const DEFAULT_REDIRECT = 'http://localhost:0';

// ---- credentials ----------------------------------------------------------

// Minimal .env reader (KEY=value lines); avoids adding a dotenv dependency.
function readDotEnv(baseDir) {
  const envPath = path.join(baseDir, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (match) {
      out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

// Resolve { clientId, clientSecret, redirectUri } from env / .env / data file.
export function loadCredentials(baseDir) {
  const dotenv = readDotEnv(baseDir);
  const clientId = process.env.GMAIL_CLIENT_ID || dotenv.GMAIL_CLIENT_ID;
  const clientSecret =
    process.env.GMAIL_CLIENT_SECRET || dotenv.GMAIL_CLIENT_SECRET;
  const redirectUri =
    process.env.GMAIL_REDIRECT_URI || dotenv.GMAIL_REDIRECT_URI || null;

  if (clientId && clientSecret) {
    return { clientId, clientSecret, redirectUri };
  }

  const credPath = path.join(baseDir, 'data', 'gmail-credentials.json');
  if (fs.existsSync(credPath)) {
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const node = raw.installed || raw.web || raw;
    return {
      clientId: node.client_id,
      clientSecret: node.client_secret,
      redirectUri: redirectUri || node.redirect_uris?.[0] || null,
    };
  }

  throw new Error(
    'No Gmail OAuth credentials found. Set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET ' +
      '(env or .env), or add data/gmail-credentials.json (a Google Cloud ' +
      '"Desktop app" OAuth client). See data/gmail-credentials.example.json.'
  );
}

// ---- OAuth token flow (issued and refreshed entirely in code) -------------

function tokenPath(baseDir) {
  return path.join(baseDir, 'data', 'gmail-token.json');
}

// Run the interactive consent flow: spin up a localhost listener, open the
// consent URL, capture the ?code=, exchange it for a token, and cache it.
function runConsentFlow(oauth2Client, baseDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url, 'http://localhost');
        const code = requestUrl.searchParams.get('code');
        const denied = requestUrl.searchParams.get('error');
        if (denied) {
          // Google sends the user back with an error when consent is refused;
          // the flow must end then, not wait for a code that never comes.
          response.writeHead(400).end(`Authorization failed: ${denied}`);
          server.close();
          reject(new Error(`consent error: ${denied}`));
          return;
        }
        if (!code) {
          response.writeHead(400).end('Missing authorization code.');
          return;
        }
        response
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            '<h2>Authorized. You can close this tab and return to the terminal.</h2>'
          );
        server.close();

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        fs.mkdirSync(path.dirname(tokenPath(baseDir)), { recursive: true });
        fs.writeFileSync(tokenPath(baseDir), JSON.stringify(tokens, null, 2));
        resolve(oauth2Client);
      } catch (error) {
        reject(error);
      }
    });

    server.listen(0, () => {
      const { port } = server.address();
      const redirectUri = `http://localhost:${port}/callback`;
      oauth2Client.redirectUri = redirectUri;
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        redirect_uri: redirectUri,
      });
      console.log('\nAuthorize this app by visiting:\n');
      console.log(`  ${authUrl}\n`);
      console.log(`Waiting for the redirect to ${redirectUri} …`);
    });

    server.on('error', reject);
  });
}

// Return an authenticated OAuth2 client: reuse the cached token (refreshing as
// needed), or run the one-time consent flow to issue a fresh one.
export async function authorize(baseDir) {
  const { clientId, clientSecret, redirectUri } = loadCredentials(baseDir);
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri || DEFAULT_REDIRECT
  );

  const cached = tokenPath(baseDir);
  if (fs.existsSync(cached)) {
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(cached, 'utf8')));
    // Persist any refreshed access token so the cache stays valid.
    oauth2Client.on('tokens', (tokens) => {
      const merged = { ...oauth2Client.credentials, ...tokens };
      fs.writeFileSync(cached, JSON.stringify(merged, null, 2));
    });
    return oauth2Client;
  }

  return await runConsentFlow(oauth2Client, baseDir);
}

// ---- search + download ----------------------------------------------------

// Default query: only the two airlines, only cancellation-related mail, last 90
// days. Every part is overridable via buildQuery() options.
//
// `exclude` drops noise: a bare term becomes a Gmail negative (-term); a value
// that looks like a domain/address becomes -from:value. This keeps unrelated
// senders (e.g. redditmail.com) out of the results.
export function buildQuery(options = {}) {
  const {
    airlines = ['indigo', 'airindia', '"air india"'],
    keywords = [
      'cancel',
      'cancellation',
      'cancelled',
      'canceled',
      'refund',
      'rescheduled',
      'reschedule',
    ],
    days = 90,
    exclude = [],
    extra = '',
  } = options;

  const airlineClause = `(${airlines.join(' OR ')})`;
  const keywordClause = `(${keywords.join(' OR ')})`;
  const excludeClause = exclude
    .map((term) => (term.includes('.') ? `-from:${term}` : `-${term}`))
    .join(' ');
  return `${airlineClause} ${keywordClause} newer_than:${days}d ${excludeClause} ${extra}`
    .replace(/\s+/g, ' ')
    .trim();
}

// List every message id matching the query (following pagination).
export async function listMessageIds(gmail, query) {
  const ids = [];
  let pageToken;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken,
    });
    for (const message of data.messages || []) {
      ids.push(message.id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

// Fetch one message as its raw RFC-2822 MIME bytes (a byte-exact .eml original).
export async function fetchRawEml(gmail, messageId) {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'raw',
  });
  // Gmail returns URL-safe base64; Buffer handles base64url directly.
  return Buffer.from(data.raw, 'base64url');
}

// Build a ready-to-use Gmail API client for the given base dir.
export async function makeGmailClient(baseDir) {
  const auth = await authorize(baseDir);
  return google.gmail({ version: 'v1', auth });
}
