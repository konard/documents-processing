import { describe, it, expect } from 'test-anywhere';
import { stripActiveContent, emailToHtml } from '../src/eml-to-pdf.mjs';

describe('an email rendered to PDF', () => {
  it('loses its scripts, frames, handlers and refreshes, and keeps its text', () => {
    const html =
      '<p onclick="steal()">Your flight <b>XX1234</b> is cancelled.</p>' +
      '<script>alert(1)</script>' +
      '<iframe src="https://evil.example"></iframe>' +
      '<meta http-equiv="refresh" content="0;url=https://evil.example">' +
      '<a href="javascript:alert(2)">details</a>' +
      '<img src="data:image/png;base64,AAAA" onerror="steal()">' +
      '<img src="data:image/png;base64,BBBB" onerror=steal() alt="x">';
    const stripped = stripActiveContent(html);
    expect(stripped).toContain('Your flight <b>XX1234</b> is cancelled.');
    expect(stripped).toContain('<img src="data:image/png;base64,AAAA">');
    // An unquoted handler ends at the tag's closing bracket, which stays.
    expect(stripped).toContain(
      '<img src="data:image/png;base64,BBBB" alt="x">'
    );
    expect(stripped).toContain('<a href="#">details</a>');
    expect(stripped).not.toContain('<script');
    expect(stripped).not.toContain('<iframe');
    expect(stripped).not.toContain('http-equiv');
    expect(stripped).not.toContain('onclick');
    expect(stripped).not.toContain('onerror');
    expect(stripped).not.toContain('javascript:');
  });

  it('escapes the envelope fields and strips the body', () => {
    const page = emailToHtml({
      from: { text: 'Someone <someone@example.com>' },
      subject: '<b>Not bold</b>',
      html: '<p>Hello</p><script>x()</script>',
      attachments: [],
    });
    expect(page).toContain('Someone &lt;someone@example.com&gt;');
    expect(page).toContain('&lt;b&gt;Not bold&lt;/b&gt;');
    expect(page).toContain('<p>Hello</p>');
    expect(page).not.toContain('<script');
  });
});
