import { describe, it, expect } from 'test-anywhere';
import { readResult, describeSearchPage } from '../src/evisa-download.mjs';

/** One page for the whole file: starting a browser is the slow part. */
let browser = null;
let page = null;

async function showing(html) {
  if (!page) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }
  await page.setContent(html);
  return page;
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
    const shown = await showing(IN_COLUMNS);
    const result = await readResult(shown);
    expect(result.status).toBe('Processing');
    expect(result.fullName).toBe('TRAVELLER JOHN');
    expect(result.applicationNumber).toBe('E260911XXX00000000000');
    expect(result.passportNumber).toBe('AB1234567');
  });

  it('reads it out of a table just as well', async () => {
    const shown = await showing(`
      <table>
        <tr><td>Full name:</td><td>TRAVELLER JOHN</td></tr>
        <tr><td>App no.:</td><td>E260911XXX00000000000</td></tr>
        <tr><td>Application status:</td><td>Granted</td></tr>
      </table>
    `);
    const result = await readResult(shown);
    expect(result.status).toBe('Granted');
    expect(result.fullName).toBe('TRAVELLER JOHN');
  });

  it('reads it out of the description lists the site also uses', async () => {
    const shown = await showing(`
      <div class="ant-descriptions-item">
        <span class="ant-descriptions-item-label">Application status</span>
        <span class="ant-descriptions-item-content">Processing</span>
      </div>
    `);
    expect((await readResult(shown)).status).toBe('Processing');
  });

  it('does not read the page´s own heading as a result', async () => {
    // "Check application status" is the banner above the search form, on the
    // page before any search is run. Matched on how a label began, it looked
    // like a result and the applicant was told an empty one had been found.
    const shown = await showing(`
      <h1>Check application status</h1>
      <p>Look up application status and electronic visa</p>
    `);
    expect(await readResult(shown)).toBe(null);
  });

  it('gives nothing for a page with no result on it', async () => {
    const shown = await showing('<div>Enter the security code</div>');
    expect(await readResult(shown)).toBe(null);
  });

  it('never reads a button as somebody´s name', async () => {
    // The buttons sit under the result, so a name looked for loosely found
    // "Save form" and the applicant was shown that as the applicant's name.
    const shown = await showing(IN_COLUMNS);
    const result = await readResult(shown);
    expect(result.fullName.includes('Save')).toBe(false);
  });

  it('says what the page is showing, for the log when nothing was read', async () => {
    const shown = await showing(IN_COLUMNS);
    const said = await describeSearchPage(shown);
    // The buttons are the sign that an application was found at all.
    expect(said.buttons).toEqual(['Save form', 'Download Receipt']);
    expect(said.labels.some((label) => label.includes('status'))).toBe(true);
  });

  it('closes the browser it opened', async () => {
    await browser?.close();
    browser = null;
    page = null;
    expect(true).toBe(true);
  });
});
