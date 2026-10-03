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
            mailboxOf: (value: string) => (value || '').trim(),
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

  it('keeps every matrix line equal to the sum of its cells and of the lines under it', () => {
    const rows = [
      row({ threadId: 'a', workflowStatus: '' }),
      row({ threadId: 'b', workflowStatus: 'Pending Unit Match', actionStatus: 'User Intervention' }),
      row({ threadId: 'c', workflowStatus: 'Pending Unit Match', actionStatus: 'Done' }),
      row({ threadId: 'd', intent: 'Agreement', subIntent: 'Agreement' }),
    ];
    const tickets = rows.map((r, i) =>
      ticket({ threadId: r.threadId, ticketId: `TKT-${i}` })
    );

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));
    const sum = (cells: { total: number }[]) => cells.reduce((total, cell) => total + cell.total, 0);

    for (const group of summary.groups) {
      expect(sum(group.cells)).toBe(group.total.total);
      expect(sum(group.rows.map((r) => r.total))).toBe(group.total.total);

      for (const matrixRow of group.rows) {
        expect(sum(matrixRow.cells)).toBe(matrixRow.total.total);
        expect(sum(matrixRow.steps.map((s) => s.total))).toBe(matrixRow.total.total);

        for (const step of matrixRow.steps) {
          expect(sum(step.cells)).toBe(step.total.total);
        }
      }
    }

    // Every open ticket is in the matrix exactly once.
    expect(sum(summary.groups.map((g) => g.total))).toBe(summary.openCount);
  });

  it('groups the matrix by intent, then sub-intent, then the step in pipeline order', () => {
    const rows = [
      row({ threadId: 'a', workflowStatus: 'Pending Bank Reconciliation' }),
      row({ threadId: 'b', workflowStatus: '' }),
      row({ threadId: 'c', workflowStatus: 'Pending Unit Match' }),
      row({
        threadId: 'd',
        category: 'Non-Payment - Customer',
        intent: 'Agreement',
        subIntent: 'Agreement',
        workflowStatus: `Pending ${AGREEMENT_STEPS[4].title}`,
      }),
    ];
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));

    // By intent, not by category: 'Payment' and 'Agreement', biggest first.
    expect(summary.groups.map((g) => g.intent)).toEqual(['Payment', 'Agreement']);
    expect(summary.intents.map((i) => i.intent)).toEqual(['Payment', 'Agreement']);

    const payment = summary.groups[0].rows[0];

    expect(payment.subIntent).toBe('Receipt Request');

    // Only the steps a ticket is on, in pipeline order — but each still
    // numbered by its place in the payment route, as its pipeline card is.
    expect(payment.steps.map((s) => s.step)).toEqual([
      'Ticket Acknowledgement',
      'Unit Match',
      'Bank Reconciliation',
    ]);
    expect(payment.steps.map((s) => s.number)).toEqual([1, 3, 5]);

    // An agreement thread runs ticket, sender, unit, then the thirteen stages,
    // so its fifth stage is step 8.
    const agreement = summary.groups[1].rows[0];

    expect(agreement.steps.map((s) => s.step)).toEqual([AGREEMENT_STEPS[4].title]);
    expect(agreement.steps.map((s) => s.number)).toEqual([8]);

    // No row of zeros anywhere in the matrix.
    for (const group of summary.groups) {
      for (const matrixRow of group.rows) {
        for (const step of matrixRow.steps) {
          expect(step.total.total).toBeGreaterThan(0);
        }
      }
    }
  });

  it('names a step as its pipeline card does, on the route the thread runs', () => {
    const stepOf = (overrides: Partial<EmailReceiptRow>) =>
      service.join([row({ threadId: 'a', ...overrides })], [ticket({ threadId: 'a' })], [], '2026-09-01')[0];

    // The column says "Customer Email Match"; the card says Verification.
    expect(stepOf({ workflowStatus: 'Pending Customer Email Match' }).step).toBe(
      'Customer Email Verification'
    );

    // A payment thread's closing step is the Final Email Response.
    expect(stepOf({ workflowStatus: 'Pending Email Response' }).step).toBe('Final Email Response');

    // A non-payment thread's is the plain reply.
    const nonPayment = stepOf({
      category: 'Non-Payment - Customer',
      workflowStatus: 'Pending Email Response',
    });

    expect(nonPayment.step).toBe('Email Response');
    expect(nonPayment.route).toEqual([
      'Ticket Acknowledgement',
      'Customer Email Verification',
      'Unit Match',
      'Email Response',
    ]);

    // A system-raised thread is two steps, whatever its intent says.
    expect(
      stepOf({ category: 'Non-Payment - System', intent: 'Agreement', subIntent: 'Agreement' }).route
    ).toEqual(['Ticket Acknowledgement', 'Email Response']);

    // A money step left on an agreement thread from before it had its own
    // route: the pipeline shows it at the first stage that has not passed.
    expect(
      stepOf({
        category: 'Non-Payment - Customer',
        intent: 'Agreement',
        subIntent: 'Agreement',
        workflowStatus: 'Pending Instrument Match',
        agreementSteps: { [AGREEMENT_STEPS[0].stepKey]: 'Match' },
      }).step
    ).toBe(AGREEMENT_STEPS[1].title);
  });

  it('counts each ticket under the column its Action Status maps to', () => {
    const rows = [
      row({ threadId: 'a', actionStatus: 'Done' }),
      row({ threadId: 'b', actionStatus: 'User Verification Required' }),
      row({ threadId: 'c', actionStatus: 'User Intervention' }),
      row({ threadId: 'd', actionStatus: 'Pending' }),
      // Never opened in the workflow screen: still the pipeline's to work.
      row({ threadId: 'e', actionStatus: '' }),
    ];
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    const joined = service.join(rows, tickets, [], '2026-09-01');

    expect(joined.map((t) => t.actionColumn)).toEqual([
      'done',
      'verify',
      'edit',
      'processing',
      'processing',
    ]);

    const cells = service.summarize(joined).groups[0].cells;

    expect(cells.map((c) => c.column)).toEqual(['done', 'verify', 'edit', 'processing']);
    expect(cells.map((c) => c.total)).toEqual([1, 1, 1, 2]);
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

  it('names the fourth arc, in grey', () => {
    // The fourth arc is the de-emphasised slot 0 — the palette has no fourth
    // hue that clears the contrast floors — but it carries its own name.
    const intents = ['A', 'B', 'C', 'Refund'];
    const rows = intents.map((intent, i) => row({ threadId: `t${i}`, intent }));
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));

    expect(summary.intents.length).toBe(4);
    expect(summary.intents[3].intent).toBe('Refund');
    expect(summary.intents[3].total).toBe(1);
    expect(summary.intents[3].slot).toBe(0);
  });

  it('lists every intent in the donut, as the matrix does, greying those past the third', () => {
    const intents = ['A', 'B', 'C', 'D', 'E'];
    const rows = intents.map((intent, i) => row({ threadId: `t${i}`, intent }));
    const tickets = rows.map((r, i) => ticket({ threadId: r.threadId, ticketId: `TKT-${i}` }));

    const summary = service.summarize(service.join(rows, tickets, [], '2026-09-01'));

    // No 'Others': the legend and the table name the same intents, in the
    // same order, in the same colours.
    expect(summary.intents.map((i) => i.intent)).toEqual(intents);
    expect(summary.intents.map((i) => i.slot)).toEqual([1, 2, 3, 0, 0]);
    expect(summary.intentSlices.map((s) => s.name)).toEqual(intents);
    expect(summary.groups.map((g) => g.intent)).toEqual(intents);
    expect(summary.groups.map((g) => g.slot)).toEqual([1, 2, 3, 0, 0]);
  });

  it('files a blank Assigned To under the CRM head, as the Ticket Automation picker does', () => {
    const joined = service.join(
      [row({ threadId: 'a', assignedTo: '' })],
      [ticket({ threadId: 'a' })],
      [],
      '2026-09-01'
    );

    // Filed by mailbox — [Assigned To] stores the emailId, not the name.
    expect(joined[0].assignedTo).toBe('head@example.com');
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
