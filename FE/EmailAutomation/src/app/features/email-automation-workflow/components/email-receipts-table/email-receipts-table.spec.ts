import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AppConfig } from '../../../../core/models/app-config.model';
import { ConfigService } from '../../../../core/services/config.service';
import { EmailReceiptsTable } from './email-receipts-table';
import { EmailReceiptRow } from '../../models/email-receipt.model';

/**
 * A cut-down config.json carrying the parts the list reads — the CRM head, who
 * owns the rows no user is named on, and the users the owner filter offers.
 *
 * Loaded the way every other spec here loads it, through the real ConfigService
 * with the request flushed: the component reaches config on its first load, and
 * without this it threw "config.json has not been loaded yet" the moment a test
 * went past creating it.
 */
const CONFIG: AppConfig = {
  apiBaseUrl: 'http://test.local/api',
  environmentName: 'test',
  appName: 'Pride Email Automation',
  version: '1.0.0',
  fallbackUser: { name: 'CRM_Head', emailId: 'workflow@test.local' },
  users: [
    { name: 'RITA', emailId: 'RITA@TEST.LOCAL', Slot: 'Post-Agreement' },
    { name: 'SURAJ', emailId: 'CRM7@TEST.LOCAL', Slot: 'Post-Agreement' },
  ],
  projectMappings: [],
  bookingStatusSlots: {},
};

describe('EmailReceiptsTable', () => {
  let component: EmailReceiptsTable;
  let fixture: ComponentFixture<EmailReceiptsTable>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [EmailReceiptsTable],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    const config = TestBed.inject(ConfigService);
    const httpMock = TestBed.inject(HttpTestingController);

    const loading = config.loadConfig();
    httpMock.expectOne((request) => request.url.startsWith('/config.json')).flush(CONFIG);
    await loading;

    fixture = TestBed.createComponent(EmailReceiptsTable);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  /**
   * A closed ticket's row.
   *
   * The stored columns still describe live work on purpose — syncActionStatus()
   * stops writing once a ticket closes, because node 1 raises a fresh open
   * ticket for the thread straight away — so these fixtures carry the stale
   * values a real closed row carries.
   */
  function rowWithTicket(status: 'Open' | 'Closed'): EmailReceiptRow {
    const row = {
      threadId: 'T1',
      workflowStatus: 'Pending Email Response',
      actionStatus: 'User Intervention',
    } as EmailReceiptRow;

    // ticketByThread is private and normally filled from node 1's response.
    (component as unknown as {
      ticketByThread: { [id: string]: { ticketId: string; ticketStatus: string } };
    }).ticketByThread = { T1: { ticketId: 'TKT-2026-000001', ticketStatus: status } };

    return row;
  }

  describe('a row whose ticket is closed', () => {
    it('shows Ticket Closed as its pending step', () => {
      expect(component.pendingStep(rowWithTicket('Closed'))).toBe('Ticket Closed');
    });

    it('shows its state as Done', () => {
      expect(component.pendingState(rowWithTicket('Closed'))).toBe('Done');
    });

    it('shows its action status as Done, not the stale User Intervention', () => {
      expect(component.rowActionStatus(rowWithTicket('Closed'))).toBe('Done');
    });
  });

  describe('ordering', () => {
    /** Seeds the ticket lookup and returns the rows in the backend's order. */
    function rowsWithTickets(pairs: [string, string][]): EmailReceiptRow[] {
      const byThread: { [id: string]: { ticketId: string; ticketStatus: string } } = {};

      for (const [threadId, ticketId] of pairs) {
        if (ticketId) {
          byThread[threadId] = { ticketId, ticketStatus: 'Open' };
        }
      }

      (component as unknown as { ticketByThread: typeof byThread }).ticketByThread = byThread;
      (component as unknown as { rows: EmailReceiptRow[] }).rows = pairs.map(
        ([threadId]) => ({ threadId }) as EmailReceiptRow
      );

      component.applyFilters();

      return component.filteredRows;
    }

    it('puts the latest ticket on top', () => {
      const ordered = rowsWithTickets([
        ['T2', 'TKT-2026-000002'],
        ['T4', 'TKT-2026-000004'],
        ['T3', 'TKT-2026-000003'],
        ['T6', 'TKT-2026-000006'],
        ['T5', 'TKT-2026-000005'],
      ]);

      expect(ordered.map((row) => row.threadId)).toEqual(['T6', 'T5', 'T4', 'T3', 'T2']);
    });

    it('orders across years, not just within one', () => {
      const ordered = rowsWithTickets([
        ['T1', 'TKT-2026-000009'],
        ['T2', 'TKT-2027-000001'],
      ]);

      expect(ordered.map((row) => row.threadId)).toEqual(['T2', 'T1']);
    });

    it('leaves rows whose ticket has not resolved yet at the bottom, in order', () => {
      const ordered = rowsWithTickets([
        ['A', ''],
        ['T1', 'TKT-2026-000001'],
        ['B', ''],
        ['T2', 'TKT-2026-000002'],
      ]);

      expect(ordered.map((row) => row.threadId)).toEqual(['T2', 'T1', 'A', 'B']);
    });

    it('leaves the backend order alone while no ticket has resolved', () => {
      const ordered = rowsWithTickets([
        ['C', ''],
        ['A', ''],
        ['B', ''],
      ]);

      expect(ordered.map((row) => row.threadId)).toEqual(['C', 'A', 'B']);
    });
  });

  describe('the row that opens by default', () => {
    /** Runs the two halves of a load: rows first, then the ticket numbers. */
    function load(pairs: [string, string][], selectedThreadId: string | null = null) {
      const picked: (EmailReceiptRow | undefined)[] = [];
      component.rowSelected.subscribe((row) => picked.push(row));
      component.selectedThreadId = selectedThreadId;

      const internals = component as unknown as {
        rows: EmailReceiptRow[];
        ticketByThread: { [id: string]: { ticketId: string; ticketStatus: string } };
        finishLoad(): void;
        selectDefaultRow(): void;
        isDefaultSelection: boolean;
      };

      // Rows land with no ticket numbers yet — that is the order the backend
      // sent, which is what finishLoad() used to open on.
      internals.rows = pairs.map(([threadId]) => ({ threadId }) as EmailReceiptRow);
      internals.ticketByThread = {};
      internals.finishLoad();

      // ...then the acknowledgement response arrives and sorts the list.
      const byThread: { [id: string]: { ticketId: string; ticketStatus: string } } = {};
      for (const [threadId, ticketId] of pairs) {
        byThread[threadId] = { ticketId, ticketStatus: 'Open' };
      }
      internals.ticketByThread = byThread;
      component.applyFilters();
      if (internals.isDefaultSelection) {
        internals.selectDefaultRow();
      }

      return { picked, internals };
    }

    const unordered: [string, string][] = [
      ['T2', 'TKT-2026-000002'],
      ['T4', 'TKT-2026-000004'],
      ['T3', 'TKT-2026-000003'],
      ['T6', 'TKT-2026-000006'],
      ['T5', 'TKT-2026-000005'],
    ];

    it('settles on the latest ticket, not the first row the backend sent', () => {
      const { picked } = load(unordered);

      expect(picked[picked.length - 1]?.threadId).toBe('T6');
      expect(component.selectedThreadId).toBe('T6');
    });

    it('keeps a thread the parent asked for by name', () => {
      const { picked } = load(unordered, 'T3');

      expect(picked[picked.length - 1]?.threadId).toBe('T3');
      expect(component.selectedThreadId).toBe('T3');
    });

    it('does not move the reviewer off a row they clicked', () => {
      const internals = component as unknown as {
        rows: EmailReceiptRow[];
        ticketByThread: { [id: string]: { ticketId: string; ticketStatus: string } };
        finishLoad(): void;
        isDefaultSelection: boolean;
      };

      internals.rows = unordered.map(([threadId]) => ({ threadId }) as EmailReceiptRow);
      internals.ticketByThread = {};
      internals.finishLoad();

      component.selectRow(internals.rows[2]); // the reviewer picks T3

      expect(internals.isDefaultSelection).toBe(false);
      expect(component.selectedThreadId).toBe('T3');
    });

    it('says so when there is nothing to open on', () => {
      const picked: (EmailReceiptRow | undefined)[] = [];
      component.rowSelected.subscribe((row) => picked.push(row));

      const internals = component as unknown as { rows: EmailReceiptRow[]; finishLoad(): void };
      internals.rows = [];
      internals.finishLoad();

      expect(picked).toEqual([undefined]);
    });
  });

  describe('a row whose ticket is still open', () => {
    it('still reads all three off the stored columns', () => {
      const row = rowWithTicket('Open');

      expect(component.pendingStep(row)).toBe('Email Response');
      expect(component.pendingState(row)).toBe('Pending');
      expect(component.rowActionStatus(row)).toBe('User Intervention');
    });
  });
});
