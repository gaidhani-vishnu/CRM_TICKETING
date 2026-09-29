import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectorRef, SimpleChange, SimpleChanges } from '@angular/core';

import { AlertPopup } from './alert-popup';
import { ConfigService } from '../../../../core/services/config.service';
import { EmailAutomationService } from '../../services/email-automation.service';
import { EmailResponseTemplateService } from '../../services/email-response-template.service';
import { EmailReceiptRow } from '../../models/email-receipt.model';
import { ThreadRepliesResponse, ThreadReply } from '../../models/thread-reply.model';
import { ThreadMessage } from '../../models/thread-message.model';

const API = 'http://test.local/api';
const REPLIES_URL = `${API}/emailautomation/thread-replies`;
const MESSAGES_URL = `${API}/emailautomation/thread-messages`;
const SAVE_URL = `${API}/emailautomation/save-thread-reply`;

/** Only the fields the popup actually reads. */
function makeRow(overrides: Partial<EmailReceiptRow> = {}): EmailReceiptRow {
  return {
    threadId: 'THR-c512a5c5',
    customerSender: 'Sandeep <sandeepsheoran12@gmail.com>',
    emailSubject: 'DEMAND PAID',
    emailBody: 'body',
    alertReceived: true,
    ...overrides,
  } as EmailReceiptRow;
}

function emptyReplies(threadId = 'THR-c512a5c5'): ThreadRepliesResponse {
  return { threadId, replies: [], message: '' };
}

function message(receivedTime: string, messageText: string): ThreadMessage {
  return {
    messageKey: `<${receivedTime}@mail>`,
    threadId: 'THR-33c4daf3',
    receivedTime,
    subject: 'Payment Receipt Email For Boston A-C Building-C Unit - 301',
    messageText,
  };
}

function reply(createdOn: string, id = 1): ThreadReply {
  return {
    id,
    threadId: 'THR-33c4daf3',
    ticketId: 'TKT-2026-000017',
    to: 'a@b.com',
    cc: '',
    bcc: '',
    subject: 'We have received your email — Ticket TKT-2026-000017',
    body: 'Dear K MANOJ KUMAR',
    status: 'Email Sent',
    createdBy: 'CRM UI',
    createdOn,
    attachments: [],
  };
}

describe('AlertPopup', () => {
  let popup: AlertPopup;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        EmailAutomationService,
        EmailResponseTemplateService,
        // The real ConfigService is filled by an APP_INITIALIZER that does not
        // run in tests, so the two values the service reads are stubbed.
        { provide: ConfigService, useValue: { apiBaseUrl: API, updatedBy: 'CRM UI' } },
      ],
    });

    httpMock = TestBed.inject(HttpTestingController);

    popup = new AlertPopup(
      TestBed.inject(EmailResponseTemplateService),
      TestBed.inject(EmailAutomationService),
      { markForCheck: () => undefined } as ChangeDetectorRef
    );
  });

  afterEach(() => {
    httpMock.verify();
  });

  /** Drives the @Input change the same way Angular would. */
  function setRow(row: EmailReceiptRow | null): void {
    const previous = popup.row;
    popup.row = row;

    const changes: SimpleChanges = {
      row: new SimpleChange(previous, row, previous === null),
    };

    popup.ngOnChanges(changes);
  }

  function flushMessages(messages: ThreadMessage[] = []): void {
    httpMock
      .expectOne((r) => r.url === MESSAGES_URL)
      .flush({ threadId: 'THR-c512a5c5', messages, message: '' });
  }

  function flushReplies(replies: unknown[] = []): void {
    httpMock
      .expectOne((r) => r.url === REPLIES_URL)
      .flush({ threadId: 'THR-c512a5c5', replies, message: '' });
  }

  /** Opens the popup on a row and lets both halves of the history land. */
  function open(messages: ThreadMessage[] = [], replies: unknown[] = []): void {
    setRow(makeRow());
    flushMessages(messages);
    flushReplies(replies);
  }

  describe('loading the history', () => {
    it('reads the messages and the replies for the row it was opened on', () => {
      setRow(makeRow());

      const messages = httpMock.expectOne((r) => r.url === MESSAGES_URL);
      const replies = httpMock.expectOne((r) => r.url === REPLIES_URL);
      expect(messages.request.params.get('threadId')).toBe('THR-c512a5c5');
      expect(replies.request.params.get('threadId')).toBe('THR-c512a5c5');

      messages.flush({ threadId: 'THR-c512a5c5', messages: [message('2026-08-27T09:00:00', 'Paid')], message: '' });
      replies.flush({ threadId: 'THR-c512a5c5', replies: [reply('2026-08-27T10:00:00')], message: '' });

      expect(popup.history.length).toBe(2);
      expect(popup.isLoadingHistory).toBe(false);
      expect(popup.repliesError).toBe('');
      expect(popup.messagesError).toBe('');
    });

    it('reads a loan row\'s messages from the email\'s thread, and its replies from its own', () => {
      setRow(makeRow({ threadId: 'THR-3bd00513-1', parentThreadId: 'THR-3bd00513' }));

      expect(
        httpMock.expectOne((r) => r.url === MESSAGES_URL).request.params.get('threadId')
      ).toBe('THR-3bd00513');
      expect(
        httpMock.expectOne((r) => r.url === REPLIES_URL).request.params.get('threadId')
      ).toBe('THR-3bd00513-1');
    });

    it('reports a failed reply load without leaving a stale list behind', () => {
      setRow(makeRow());
      flushMessages([message('2026-08-27T09:00:00', 'Paid')]);
      httpMock.expectOne((r) => r.url === REPLIES_URL).flush('nope', { status: 500, statusText: 'Server Error' });

      expect(popup.replies).toEqual([]);
      expect(popup.isLoadingHistory).toBe(false);
      expect(popup.repliesError).toBeTruthy();
      // What did load still shows.
      expect(popup.history.length).toBe(1);
    });

    it('drops the previous thread history the moment the row changes', () => {
      open([message('2026-08-27T09:00:00', 'Paid')]);

      setRow(makeRow({ threadId: 'THR-other' }));
      expect(popup.history).toEqual([]);
      expect(popup.messages).toEqual([]);

      expect(
        httpMock.expectOne((r) => r.url === MESSAGES_URL).request.params.get('threadId')
      ).toBe('THR-other');
      httpMock.expectOne((r) => r.url === REPLIES_URL).flush(emptyReplies('THR-other'));
    });

    it('does not call out at all when the row goes away', () => {
      setRow(null);
      httpMock.expectNone((r) => r.url === REPLIES_URL);
      httpMock.expectNone((r) => r.url === MESSAGES_URL);
    });
  });

  describe('the conversation', () => {
    it('interleaves messages and replies by time, oldest first (THR-33c4daf3)', () => {
      // The live thread: the customer's mail, our acknowledgement, then two
      // more mails from the customer.
      open(
        [
          message('2026-09-24T15:10:20.0000000', 'Hi Team, Please find attached Payment Receipt'),
          message('2026-09-24T15:18:03.0000000', 'Yes All Right'),
          message('2026-09-24T15:23:36.0000000', 'Please Call Me'),
        ],
        [reply('2026-09-24T15:13:30.9530000')]
      );

      expect(popup.history.map((e) => e.kind)).toEqual(['received', 'sent', 'received', 'received']);
      expect(popup.history.map((e) => e.at)).toEqual([
        '2026-09-24T15:10:20.0000000',
        '2026-09-24T15:13:30.9530000',
        '2026-09-24T15:18:03.0000000',
        '2026-09-24T15:23:36.0000000',
      ]);
    });

    it('stands the row\'s Email Body in as the first mail when the thread has no messages', () => {
      open([], [reply('2026-08-27T10:00:00')]);

      expect(popup.history.map((e) => e.kind)).toEqual(['received', 'sent']);

      const first = popup.history[0];
      expect(first.kind === 'received' && first.message.messageText).toBe('body');
      expect(first.kind === 'received' && popup.isFallbackMessage(first.message)).toBe(true);
    });

    it('does not invent a first mail when the messages failed to load', () => {
      setRow(makeRow());
      httpMock.expectOne((r) => r.url === MESSAGES_URL).flush('nope', { status: 500, statusText: 'Server Error' });
      flushReplies();

      expect(popup.messagesError).toBeTruthy();
      expect(popup.history).toEqual([]);
    });

    it('puts a message ahead of a reply saved at the same moment', () => {
      open([message('2026-08-27T10:00:00', 'Paid')], [reply('2026-08-27T10:00:00')]);

      expect(popup.history.map((e) => e.kind)).toEqual(['received', 'sent']);
    });

    it('adds a saved reply to the end without a reload', () => {
      open([message('2026-08-27T09:00:00', 'Paid')]);

      popup.onRespond();
      popup.compose!.body = 'Noted.';
      popup.onSend();

      httpMock
        .expectOne(SAVE_URL)
        .flush({ threadId: 'THR-c512a5c5', replies: [reply('2026-08-27T10:00:00')], message: 'Saved.' });

      expect(popup.history.map((e) => e.kind)).toEqual(['received', 'sent']);
    });
  });

  describe('opening the compose', () => {
    beforeEach(() => open());

    it('addresses it to the customer and leaves everything else empty', () => {
      popup.onRespond();

      expect(popup.compose).toBeTruthy();
      expect(popup.compose!.to).toEqual(['sandeepsheoran12@gmail.com']);
      expect(popup.compose!.cc).toEqual([]);
      expect(popup.compose!.bcc).toEqual([]);
      expect(popup.compose!.body).toBe('');
      expect(popup.compose!.attachments).toEqual([]);
      expect(popup.showCc).toBe(false);
      expect(popup.showBcc).toBe(false);
    });

    it('throws the whole draft away on Discard', () => {
      popup.onRespond();
      popup.compose!.body = 'half a reply';
      popup.onDiscard();

      expect(popup.compose).toBeNull();
    });
  });

  describe('saving', () => {
    beforeEach(() => {
      open();
      popup.onRespond();
      popup.compose!.body = 'Thank you for confirming.';
    });

    it('posts the draft and replaces the history from the response', () => {
      let announced = '';
      popup.saved.subscribe((text) => (announced = text));

      popup.onSend();

      const request = httpMock.expectOne(SAVE_URL);
      expect(request.request.method).toBe('POST');
      expect(request.request.body.threadId).toBe('THR-c512a5c5');
      expect(request.request.body.to).toEqual(['sandeepsheoran12@gmail.com']);
      expect(request.request.body.body).toBe('Thank you for confirming.');
      expect(request.request.body.updatedBy).toBe('CRM UI');

      request.flush({
        threadId: 'THR-c512a5c5',
        replies: [reply('2026-08-27T10:00:00', 4)],
        message: 'Reply saved against thread THR-c512a5c5.',
      });

      expect(popup.replies.length).toBe(1);
      expect(popup.compose).toBeNull();
      expect(popup.isSaving).toBe(false);
      expect(announced).toBe('Reply saved against thread THR-c512a5c5.');
    });

    it('KEEPS the typed reply when the save fails', () => {
      popup.onSend();

      httpMock.expectOne(SAVE_URL).flush(
        { message: 'The reply could not be saved.' },
        { status: 500, statusText: 'Server Error' }
      );

      // The one thing here that cannot be recovered is what was typed.
      expect(popup.compose).toBeTruthy();
      expect(popup.compose!.body).toBe('Thank you for confirming.');
      expect(popup.isSaving).toBe(false);
      expect(popup.composeError).toBe('The reply could not be saved.');
    });

    it('refuses to post a reply with no recipient', () => {
      popup.compose!.to = [];
      popup.onSend();

      httpMock.expectNone(SAVE_URL);
      expect(popup.composeError).toBeTruthy();
    });

    it('refuses to post an empty body', () => {
      popup.compose!.body = '   ';
      popup.onSend();

      httpMock.expectNone(SAVE_URL);
      expect(popup.composeError).toBeTruthy();
    });

    it('ignores a second click while the first save is still in flight', () => {
      popup.onSend();
      popup.onSend();

      httpMock.expectOne(SAVE_URL).flush(emptyReplies());
    });
  });

  describe('attachments', () => {
    beforeEach(() => {
      open();
      popup.onRespond();
    });

    /** A change event carrying `files`, as the file input would raise it. */
    function pick(files: File[]): Event {
      return {
        target: { files, value: 'C:\\fakepath\\x' },
      } as unknown as Event;
    }

    function fileOfSize(name: string, bytes: number): File {
      const file = new File(['x'], name);
      Object.defineProperty(file, 'size', { value: bytes });
      return file;
    }

    it('refuses a file over the per-file limit, and attaches nothing', () => {
      popup.onFilesPicked(pick([fileOfSize('huge.pdf', 11 * 1024 * 1024)]));

      expect(popup.compose!.attachments).toEqual([]);
      expect(popup.composeError).toContain('10 MB');
    });

    it('refuses an empty file', () => {
      popup.onFilesPicked(pick([fileOfSize('nothing.txt', 0)]));

      expect(popup.compose!.attachments).toEqual([]);
      expect(popup.composeError).toContain('empty');
    });

    it('refuses more than ten files', () => {
      popup.compose!.attachments = Array.from({ length: 10 }, (_, i) => ({
        fileName: `f${i}.pdf`,
        contentBase64: '',
        sizeBytes: 10,
      }));

      popup.onFilesPicked(pick([fileOfSize('eleventh.pdf', 10)]));

      expect(popup.compose!.attachments.length).toBe(10);
      expect(popup.composeError).toContain('at most 10 files');
    });

    it('refuses a file that would push the reply over the total limit', () => {
      popup.compose!.attachments = [
        { fileName: 'big.pdf', contentBase64: '', sizeBytes: 20 * 1024 * 1024 },
      ];

      popup.onFilesPicked(pick([fileOfSize('another.pdf', 9 * 1024 * 1024)]));

      expect(popup.compose!.attachments.length).toBe(1);
      expect(popup.composeError).toContain('25 MB');
    });

    it('removes the attachment at the index the × belongs to', () => {
      popup.compose!.attachments = [
        { fileName: 'a.pdf', contentBase64: '', sizeBytes: 1 },
        { fileName: 'b.pdf', contentBase64: '', sizeBytes: 2 },
        { fileName: 'c.pdf', contentBase64: '', sizeBytes: 3 },
      ];

      popup.removeAttachment(1);

      expect(popup.compose!.attachments.map((a) => a.fileName)).toEqual(['a.pdf', 'c.pdf']);
    });
  });

  /** Respond sits once, under the last entry of the conversation. */
  describe('the Respond button', () => {
    it('shows once the history has loaded', () => {
      open();

      expect(popup.canRespond).toBe(true);
    });

    it('waits while either half of the history is still loading', () => {
      setRow(makeRow());
      expect(popup.canRespond).toBe(false);

      flushMessages();
      expect(popup.canRespond).toBe(false);

      flushReplies();
      expect(popup.canRespond).toBe(true);
    });

    it('hides while the compose is open, and comes back after Discard', () => {
      open();

      popup.onRespond();
      expect(popup.canRespond).toBe(false);

      popup.onDiscard();
      expect(popup.canRespond).toBe(true);
    });

    it('still shows when the history could not be loaded', () => {
      setRow(makeRow());
      httpMock.expectOne((r) => r.url === MESSAGES_URL).flush('nope', { status: 500, statusText: 'Server Error' });
      httpMock.expectOne((r) => r.url === REPLIES_URL).flush('nope', { status: 500, statusText: 'Server Error' });

      expect(popup.canRespond).toBe(true);
    });
  });

  describe('display helpers', () => {
    it('formats sizes the way the chips read them', () => {
      expect(popup.readableSize(512)).toBe('512 B');
      expect(popup.readableSize(2048)).toBe('2 KB');
      expect(popup.readableSize(3 * 1024 * 1024)).toBe('3.0 MB');
    });

    it('hands back an unparseable timestamp untouched rather than "Invalid Date"', () => {
      expect(popup.readableWhen('not a date')).toBe('not a date');
      expect(popup.readableWhen('')).toBe('');
    });
  });
});
