import { describe, it, expect } from 'test-anywhere';
import { readResult, describeSearchPage } from '../src/evisa-download.mjs';

/** Runs an assertion against one isolated page and closes its browser. */
async function showing(html, read) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return await read(page);
  } finally {
    await browser.close();
  }
}

/** The result as the site lays it out: label and value in their own cells. */
const IN_COLUMNS = `
  <div><div><label>Full name:</label></div><div><span>TRAVELLER JOHN</span></div></div>
  <div><div><label>Passport:</label></div><div><span>AB1234567</span></div></div>
  <div><div><label>App no.:</label></div><div><span>E260911XXX00000000000</span></div></div>
  <div><div><label>Application status:</label></div><div><span>Processing</span></div></div>
  <button>Save form</button><button>Download Receipt</button>
`;

describe('reading what the search found', () => {
  it('reads the result the site lays out in columns', async () => {
    const result = await showing(IN_COLUMNS, readResult);
    expect(result.status).toBe('Processing');
    expect(result.fullName).toBe('TRAVELLER JOHN');
    expect(result.applicationNumber).toBe('E260911XXX00000000000');
    expect(result.passportNumber).toBe('AB1234567');
  });

  it('reads it out of a table just as well', async () => {
    const result = await showing(
      `
        <table>
          <tr><td>Full name:</td><td>TRAVELLER JOHN</td></tr>
          <tr><td>App no.:</td><td>E260911XXX00000000000</td></tr>
          <tr><td>Application status:</td><td>Granted</td></tr>
        </table>
      `,
      readResult
    );
    expect(result.status).toBe('Granted');
    expect(result.fullName).toBe('TRAVELLER JOHN');
  });

  it('reads it out of the description lists the site also uses', async () => {
    const result = await showing(
      `
        <div class="ant-descriptions-item">
          <span class="ant-descriptions-item-label">Application status</span>
          <span class="ant-descriptions-item-content">Processing</span>
        </div>
      `,
      readResult
    );
    expect(result.status).toBe('Processing');
  });

  it('does not read the page´s own heading as a result', async () => {
    // "Check application status" is the banner above the search form, on the
    // page before any search is run. Matched on how a label began, it looked
    // like a result and the applicant was told an empty one had been found.
    const result = await showing(
      `
        <h1>Check application status</h1>
        <p>Look up application status and electronic visa</p>
      `,
      readResult
    );
    expect(result).toBe(null);
  });

  it('gives nothing for a page with no result on it', async () => {
    const result = await showing(
      '<div>Enter the security code</div>',
      readResult
    );
    expect(result).toBe(null);
  });

  it('never reads a button as somebody´s name', async () => {
    // The buttons sit under the result, so a name looked for loosely found
    // "Save form" and the applicant was shown that as the applicant's name.
    const result = await showing(IN_COLUMNS, readResult);
    expect(result.fullName.includes('Save')).toBe(false);
  });

  it('says what the page is showing, for the log when nothing was read', async () => {
    const said = await showing(IN_COLUMNS, describeSearchPage);
    // The buttons are the sign that an application was found at all.
    expect(said.buttons).toEqual(['Save form', 'Download Receipt']);
    expect(said.labels.some((label) => label.includes('status'))).toBe(true);
  });
});
