import { TestBed } from '@angular/core/testing';

import { ConfigService } from '../../../core/services/config.service';
import { EmailReceiptRow } from '../../email-automation-workflow/models/email-receipt.model';
import { TicketAcknowledgementItem } from '../../email-automation-workflow/models/ticket-acknowledgement.model';
import { WORKFLOW_STAGES } from '../models/user-dashboard.model';
import { AGREEMENT_STEPS } from '../../email-automation-workflow/models/agreement-step.model';
import { UserDashboardService } from './user-dashboard.service';

/** A receipt row with everything blank, so each test names only what it cares about. */
function row(overrides: Partial<EmailReceiptRow>): EmailReceiptRow {
  return {
    emailReceiptsId: '1',
    threadId: 't1',
    category: 'Payment - Customer',
    runDate: '',
    emailDate: '01-Sep-26',
    emailSubject: '',
    customerName: 'Vivek Kumar',
    project: '',
    subProject: '',
    unit: '',
    customerSender: 'vivek@example.com',
    emailLink: '',
    emailBody: '',
    forwardDetails: '',
    intent: 'Payment',
    subIntent: 'Receipt Request',
    sentiment: '',
    actionRequired: '',
    reason: '',
    confidence: '',
    customerSpecific: '',
    aiCustomerEmail: '',
    workflowStatus: '',
    turnAroundDateTime: '',
    assignedTo: 'KAILASH D',
    ...overrides,
  };
}

/** 'yyyy-MM-dd HH:mm:ss' for this browser's today, shifted by whole days. */
function closedStamp(daysAgo = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const pad = (n: number) => n.toString().padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 12:00:00`;
}

function ticket(overrides: Partial<TicketAcknowledgementItem>): TicketAcknowledgementItem {
  return {
    threadId: 't1',
    ticketId: 'TKT-2026-000001',
    emailDate: '01-Sep-26',
    sla: '24 Hours',
    createdDate: '2026-09-01 10:00:00',
    slaDue: '2026-09-02 10:00:00',
    slaStatus: 'On Track',
    closedOn: '',
    slaRemainingSeconds: 36000,
    ticketStatus: 'Open',
    emailLink: '',
    isNew: false,
    ...overrides,
  };
}

describe('UserDashboardService', () => {
  let service: UserDashboardService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ConfigService,
          useValue: {
            projectMappings: [],
            fallbackUser: { name: 'CRM_Head', emailId: 'head@example.com' },
            getEmailForUser: () => '',
          },
        },
      ],
    });

    service = TestBed.inject(UserDashboardService);
    service.clearCache();
  });

  it('joins receipts to tickets on threadId and drops threads with no ticket', () => {
    const rows = [row({ threadId: 'a' }), row({ threadId: 'b' })];
    const tickets = [ticket({ threadId: 'a', ticketId: 'TKT-1' })];

    const joined = service.join(rows, tickets, [], '2026-09-01');

    expect(joined.length).toBe(1);
    expect(joined[0].ticketId).toBe('TKT-1');
    expect(joined[0].customerName).toBe('Vivek Kumar');
    expect(joined[0].sourceDate).toBe('2026-09-01');
  });

  it('maps every Workflow Status to its stage column, and a blank one to Ack', () => {
    for (const stage of WORKFLOW_STAGES) {
      // The Agreement column stands for thirteen statuses rather than one, so
      // it has no workflowStatus of its own to feed in — the first stage's is
      // representative, and the test below covers all thirteen.
      const workflowStatus = stage.matches
        ? `Pending ${AGREEMENT_STEPS[0].title}`
        : stage.workflowStatus;

      const joined = service.join(
        [row({ threadId: 'a', workflowStatus })],
        [ticket({ threadId: 'a' })],
        [],
        stage.key
      );

      expect(joined[0].stage).toBe(stage.key);
    }
  });

  it('puts every Agreement Workflow stage in the one Agreement column', () => {
    for (const step of AGREEMENT_STEPS) {
      const joined = service.join(
        [row({ threadId: 'a', workflowStatus: `Pending ${step.title}` })],
        [ticket({ threadId: 'a' })],
        [],
        '2026-09-01'
      );

      expect(joined[0].stage).toBe('agreement');
    }
  });

  it('counts open and closed tickets separately', () => {
    const joined = service.join(
      [row({ threadId: 'a' }), row({ threadId: 'b' })],
      [ticket({ threadId: 'a', ticketId: 'TKT-1' })],
      [
        ticket({
          threadId: 'b',
          ticketId: 'TKT-2',
          ticketStatus: 'Closed',
          slaStatus: 'Met',
          closedOn: closedStamp(),
        }),
      ],
      '2026-09-01'
    );

    const summary = service.summarize(joined);

    expect(summary.openCount).toBe(1);
    expect(summary.closedCount).toBe(1);
  });

  it('counts only tickets closed today as Closed Today', () => {
    const closed = (threadId: string, ticketId: string, closedOn: string) =>
      ticket({ threadId, ticketId, ticketStatus: 'Closed', slaStatus: 'Met', closedOn });

    const joined = service.join(
      [row({ threadId: 'a' }), row({ threadId: 'b' }), row({ threadId: 'c' })],
      [],
      [
        closed('a', 'TKT-1', closedStamp()),
        closed('b', 'TKT-2', closedStamp(1)),
        // Closed before SLA_Closed_On was stamped: no day to call today.
        closed('c', 'TKT-3', ''),
      ],
      '2026-09-01'
    );

    expect(service.summarize(joined).closedCount).toBe(1);
  });

  it('keeps each matrix row total equal to the sum of its stage cells', () => {
    const rows = [
      row({ threadId: 'a', workflowStatus: '' }),
      row({ threadId: 'b', workflowStatus: 'Pending Unit Match' }),
      row({ threadId: 'c', workflowStatus: 'Pending Unit Match' }),
    ];
    const tickets = rows.map((r, i) =>
      ticket({ threadId: r.threadId, ticketId: `TKT-${i}` })
    );

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));

    for (const group of summary.groups) {
      for (const matrixRow of group.rows) {
        const summed = matrixRow.cells.reduce((total, cell) => total + cell.total, 0);
        expect(summed).toBe(matrixRow.total.total);
      }
    }
  });

  it('makes the SLA buckets sum to the open-ticket count', () => {
    const rows = [
      row({ threadId: 'a' }),
      row({ threadId: 'b' }),
      row({ threadId: 'c' }),
      row({ threadId: 'd' }),
    ];
    const tickets = [
      // On track: more than eight hours left.
      ticket({ threadId: 'a', ticketId: 'TKT-1', slaRemainingSeconds: 40000 }),
      // Due in eight hours.
      ticket({ threadId: 'b', ticketId: 'TKT-2', slaRemainingSeconds: 20000 }),
      // Due in four hours.
      ticket({ threadId: 'c', ticketId: 'TKT-3', slaRemainingSeconds: 3600 }),
      // Breached.
      ticket({
        threadId: 'd',
        ticketId: 'TKT-4',
        slaStatus: 'Overdue',
        slaRemainingSeconds: -500,
      }),
    ];

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));
    const summed = summary.slaBuckets.reduce((total, bucket) => total + bucket.count, 0);

    expect(summed).toBe(summary.openCount);
    expect(summary.overdueCount).toBe(1);
    expect(summary.slaPercent).toBe(75);
  });

  it('counts only the human-gate action statuses as intervention', () => {
    const rows = [
      row({ threadId: 'a', actionStatus: 'User Verification Required' }),
      row({ threadId: 'b', actionStatus: 'User Intervention' }),
      row({ threadId: 'c', actionStatus: 'Done' }),
      row({ threadId: 'd', actionStatus: '' }),
    ];
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));

    expect(summary.interventionTotal).toBe(2);
    expect(summary.interventions.map((item) => item.status)).toEqual([
      'User Verification Required',
      'User Intervention',
    ]);
  });

  it('names the fourth arc when one category is folded into it', () => {
    // Four categories is the live shape: the three the donut can colour, plus
    // Payment - Loan/Bank. The fourth arc is still the de-emphasised slot 0 —
    // the palette has no fourth hue that clears the contrast floors — but it
    // carries its own name, because 'Others' would hide a category the Intent
    // table beside it names in full.
    const categories = ['A', 'B', 'C', 'Payment - Loan/Bank'];
    const rows = categories.map((_, i) => row({ threadId: `t${i}` }));
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    const joined = service
      .join(rows, tickets, [], '2026-09-01')
      .map((t, i) => ({ ...t, category: categories[i] }));

    const summary = service.summarize(joined);

    expect(summary.intents.length).toBe(4);
    expect(summary.intents[3].intent).toBe('Payment - Loan/Bank');
    expect(summary.intents[3].total).toBe(1);
    expect(summary.intents[3].slot).toBe(0);
  });

  it('folds categories past the third into a single Others slice', () => {
    const categories = ['A', 'B', 'C', 'D', 'E'];
    const rows = categories.map((_, i) => row({ threadId: `t${i}` }));
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    // Renamed after the join rather than in the rows: join() only admits the
    // categories the workspace lists, and the fold is a property of the pivot.
    const joined = service
      .join(rows, tickets, [], '2026-09-01')
      .map((t, i) => ({ ...t, category: categories[i] }));

    const summary = service.summarize(joined);

    expect(summary.intents.length).toBe(4);
    expect(summary.intents[3].intent).toBe('Others');
    expect(summary.intents[3].total).toBe(2);
    expect(summary.intents[3].slot).toBe(0);

    // The matrix does not fold: every real category keeps its own block.
    expect(summary.groups.length).toBe(5);
  });

  it('files a blank Assigned To under the CRM head, as the Ticket Automation picker does', () => {
    const joined = service.join(
      [row({ threadId: 'a', assignedTo: '' })],
      [ticket({ threadId: 'a' })],
      [],
      '2026-09-01'
    );

    expect(joined[0].assignedTo).toBe('CRM_Head');
  });

  it('counts a re-opened thread once, on the closed side', () => {
    // What THR-fee2d5a7 looks like: node 1 raised TKT-2026-000194 the moment
    // TKT-2026-000093 was closed, so the thread holds both at once.
    const joined = service.join(
      [row({ threadId: 'a' }), row({ threadId: 'b' })],
      [
        ticket({ threadId: 'a', ticketId: 'TKT-1' }),
        ticket({ threadId: 'b', ticketId: 'TKT-194' }),
      ],
      [
        ticket({
          threadId: 'b',
          ticketId: 'TKT-93',
          ticketStatus: 'Closed',
          slaStatus: 'Met',
          closedOn: closedStamp(),
        }),
      ],
      '2026-09-01'
    );

    const summary = service.summarize(joined);

    // Two rows on screen, one of them settled: Open and Closed must not both
    // claim thread b, or Open runs one ahead of the grid.
    expect(summary.openCount).toBe(1);
    expect(summary.closedCount).toBe(1);
  });

  it('counts one closed ticket once however many dates its thread appears on', () => {
    const closed = ticket({
      threadId: 'a',
      ticketId: 'TKT-93',
      ticketStatus: 'Closed',
      slaStatus: 'Met',
      closedOn: closedStamp(),
    });

    // The same thread written in on two reports, as All Dates merges them.
    const joined = service
      .join([row({ threadId: 'a' })], [ticket({ threadId: 'a' })], [closed], '2026-09-01')
      .concat(
        service.join([row({ threadId: 'a' })], [ticket({ threadId: 'a' })], [closed], '2026-09-02')
      );

    expect(service.summarize(joined).closedCount).toBe(1);
  });

  it('drops threads in a category the Email Receipts grid does not show', () => {
    const rows = [
      row({ threadId: 'a', category: 'Payment - Customer' }),
      row({ threadId: 'b', category: 'Non-Payment - Customer' }),
      row({ threadId: 'c', category: 'Non-Payment - System' }),
      row({ threadId: 'd', category: 'Payment - Unverified' }),
    ];
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));

    // Node 1 raises a ticket for all four threads; only the three the grid
    // lists may reach the ribbon, or its Open figure reads higher than the
    // count beside "Email Receipts".
    expect(summary.openCount).toBe(3);
  });

  it('counts a loan customer thread as its own ticket', () => {
    // A loan email arrives from the backend as one row per customer, each
    // keyed on its [Customer Thread ID] and ticketed on the same key — so two
    // customers of one email are two tickets here, and the email itself, which
    // the grid never lists, is not one at all.
    const rows = [
      row({
        threadId: 'THR-3bd00513-1',
        customerThreadId: 'THR-3bd00513-1',
        parentThreadId: 'THR-3bd00513',
        category: 'Payment - Loan/Bank',
      }),
      row({
        threadId: 'THR-3bd00513-19',
        customerThreadId: 'THR-3bd00513-19',
        parentThreadId: 'THR-3bd00513',
        category: 'Payment - Loan/Bank',
      }),
    ];
    const tickets = [
      ticket({ threadId: 'THR-3bd00513-1', ticketId: 'TKT-2026-000101' }),
      ticket({ threadId: 'THR-3bd00513-19', ticketId: 'TKT-2026-000119' }),
      ticket({ threadId: 'THR-3bd00513', ticketId: 'TKT-2026-000083' }),
    ];

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));

    expect(summary.openCount).toBe(2);
  });

  it('serves a date from the cache once it has been joined', () => {
    expect(service.getCached('2026-09-01')).toBeNull();

    service.join([row({ threadId: 'a' })], [ticket({ threadId: 'a' })], [], '2026-09-01');

    expect(service.getCached('2026-09-01')?.length).toBe(1);

    service.clearCache();

    expect(service.getCached('2026-09-01')).toBeNull();
  });
});
