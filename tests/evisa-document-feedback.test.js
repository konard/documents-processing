import { describe, it, expect } from 'test-anywhere';
import {
  noteDocumentIssue,
  describeDocumentIssues,
  clearDocumentIssues,
  takeDocumentIssues,
  restoreDocumentIssues,
} from '../src/evisa-document-feedback.mjs';
import { MESSAGES } from '../src/evisa-messages.mjs';

describe('one account of every document problem in a batch', () => {
  it('collects every repeated problem in one account', () => {
    const session = {};
    noteDocumentIssue(session, 'downloadFailed');
    noteDocumentIssue(session, 'downloadFailed');
    noteDocumentIssue(session, 'compressedPhoto');

    const said = describeDocumentIssues(session, MESSAGES.ru);
    expect(said.includes('2 файла')).toBe(true);
    expect(said.includes('Telegram не скачаны')).toBe(true);
    expect(said.includes('качестве фото')).toBe(true);
    expect(said.includes('Telegram сжал 1 фото')).toBe(true);
  });

  it('remains available until the batch answer is sent', () => {
    const session = {};
    noteDocumentIssue(session, 'unknownImage');
    expect(describeDocumentIssues(session, MESSAGES.en)).toContain(
      'not identified or used'
    );
    clearDocumentIssues(session);
    expect(describeDocumentIssues(session, MESSAGES.en)).toBe('');
  });

  it('detaches only the warnings already included in an answer', () => {
    const session = {};
    noteDocumentIssue(session, 'downloadFailed');
    const sent = takeDocumentIssues(session);
    noteDocumentIssue(session, 'unknownImage');

    expect(describeDocumentIssues(sent, MESSAGES.en)).toContain(
      'did not download'
    );
    expect(describeDocumentIssues(session, MESSAGES.en)).toContain(
      'not identified or used'
    );
  });

  it('merges a failed answer back without losing newer warnings', () => {
    const session = {};
    noteDocumentIssue(session, 'downloadFailed');
    const unsent = takeDocumentIssues(session);
    noteDocumentIssue(session, 'downloadFailed');
    noteDocumentIssue(session, 'unknownImage');
    restoreDocumentIssues(session, unsent);

    expect(session.documentIssues).toEqual({
      downloadFailed: 2,
      unknownImage: 1,
    });
  });
});
