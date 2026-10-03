import { Injectable } from '@angular/core';

import {
  AgreementStep,
  agreementStepByNodeId,
} from '../models/agreement-step.model';
import { ConfigService } from '../../../core/services/config.service';
import { EmailReceiptDetailRow } from '../models/email-receipt-detail.model';
import { EmailReceiptRow } from '../models/email-receipt.model';
import { EmailResponseTemplate } from '../models/email-response.model';
import { WorkflowStepId } from './workflow-steps/workflow-step.model';

/** The subject fragment and the body of one Agreement Workflow stage's reply. */
interface AgreementStageCopy {
  /** Appended to the customer's own subject, e.g. 'Agreement drafted'. */
  subject: string;
  /** The stage's own paragraph. Everything around it is shared. */
  lines: string[];
}

/**
 * What each of the thirteen stages says to the customer, keyed by step key.
 *
 * Kept here rather than on AGREEMENT_STEPS: that list is the workflow's shape,
 * read by the pipeline, the cards and the dashboard, and none of them has any
 * use for the wording of an email. A stage added there without an entry here is
 * a compile error at the lookup, which is the point.
 */
const AGREEMENT_STAGE_COPY: { [stepKey: string]: AgreementStageCopy } = {
  'booking-kyc': {
    subject: 'Booking and KYC verified',
    lines: [
      'We have verified your booking and the KYC documents on file against our records.',
      'Your agreement will now be drafted.',
    ],
  },
  'agreement-drafting': {
    subject: 'Agreement drafted',
    lines: [
      'The draft of your agreement has been prepared and is now with our team for the next stage.',
      'No action is needed from you at this point.',
    ],
  },
  'sdr-bsl-coordination': {
    subject: 'SDR / BSL coordination underway',
    lines: [
      'Your agreement is being coordinated with the SDR and BSL teams so that the commercial',
      'terms on it match what was agreed at the time of booking.',
    ],
  },
  'agreement-approval': {
    subject: 'Agreement approved internally',
    lines: [
      'Your agreement has been reviewed and approved internally.',
      'It now moves to the payment and ERP update stage.',
    ],
  },
  'payment-erp-update': {
    subject: 'Payment recorded and ERP updated',
    lines: [
      'The payment against your agreement has been recorded and your account has been updated in',
      'our ERP. Please retain your payment reference for your own records.',
    ],
  },
  'document-preparation': {
    subject: 'Documents being prepared',
    lines: [
      'The document set for execution of your agreement is being prepared.',
      'We will write to you again when it is ready for signature.',
    ],
  },
  'agreement-execution': {
    subject: 'Agreement ready for execution',
    lines: [
      'Your agreement is ready for execution. Please arrange to sign the agreement along with the',
      'consent form and the allied documents shared with you.',
      'Kindly carry an original photo identity document when you attend.',
    ],
  },
  'stamp-duty-challan': {
    subject: 'Stamp duty challan',
    lines: [
      'The stamp duty challan for your agreement has been generated and paid.',
      'A copy will be filed with your registration papers.',
    ],
  },
  'registration-data': {
    subject: 'Registration data processed',
    lines: [
      'The data required for registration of your agreement has been prepared and checked.',
      'Your registration will now be scheduled.',
    ],
  },
  'registration-scheduling': {
    subject: 'Registration being scheduled',
    lines: [
      'We are scheduling your registration appointment with the sub-registrar.',
      'We will confirm the date and time with you as soon as the slot is booked.',
    ],
  },
  'ho-signature': {
    subject: 'Head office signature',
    lines: [
      'Your agreement is with our head office for signature.',
      'It will be returned in time for your registration appointment.',
    ],
  },
  'registration-appointment': {
    subject: 'Registration appointment',
    lines: [
      'Your registration appointment is confirmed. Please attend the sub-registrar office at the',
      'appointed time with your original identity documents and the payment receipts issued to you.',
    ],
  },
  'ghoshvara-verification': {
    subject: 'Ghoshvara verification',
    lines: [
      'The Ghoshvara record for your agreement is being verified against the registered documents.',
      'This is the last stage before we close your request.',
    ],
  },
};

/** Everything a template can draw on. Payments are only needed by nodes 4 and 5. */
export interface EmailResponseContext {
  row: EmailReceiptRow;
  ticketId: string;
  payments: EmailReceiptDetailRow[];
}

/**
 * Drafts the reply that goes back to the customer when a pipeline step stops.
 *
 * One template per step, because what the customer is being asked for is
 * different every time: an address that is not on the booking, a unit that does
 * not match, a UTR the bank statement has never seen, an amount that does not
 * reconcile. A generic "there is a problem with your payment" would put the work
 * of saying what is wrong back on the reviewer, which is what the pipeline
 * already knows.
 *
 * Only drafting happens here. Nothing is sent, and the reviewer edits every
 * template in the popup before it would be.
 */
@Injectable({ providedIn: 'root' })
export class EmailResponseTemplateService {
  constructor(private readonly config: ConfigService) {}

  /** The template for one step, or null when that step has nothing to write about. */
  forStep(stepId: WorkflowStepId, context: EmailResponseContext): EmailResponseTemplate | null {
    const template = this.build(stepId, context);

    if (template) {
      // Filled in one place rather than in each template: the recipient is the
      // person who wrote in, and the sender is the mailbox that owns the thread,
      // whichever step is answering them.
      template.to = this.recipient(context.row);
      template.from = this.sender(context.row);

      // Likewise what the reply is filed against once it is sent. No template
      // decides these either — they are the thread the popup was opened on.
      template.threadId = context.row.threadId;
      template.ticketId = (context.ticketId || '').trim();
    }

    return template;
  }

  private build(stepId: WorkflowStepId, context: EmailResponseContext): EmailResponseTemplate | null {
    // The Agreement Workflow's thirteen stages, matched against AGREEMENT_STEPS
    // rather than given thirteen cases: their ids come from the same list that
    // builds their pipeline cards, so a stage cannot exist without a template
    // or draft one belonging to a different stage.
    const agreementStep = agreementStepByNodeId(stepId);

    if (agreementStep) {
      return this.agreementStepTemplate(agreementStep, context);
    }

    switch (stepId) {
      case 'node-1':
        return this.ticketAcknowledgementTemplate(context);
      case 'node-2':
        return this.customerEmailTemplate(context);
      case 'node-3':
        return this.unitMatchTemplate(context);
      case 'node-4':
        return this.instrumentMatchTemplate(context);
      case 'node-5':
        // The same step now answers two different things: a query while a
        // payment is still unreconciled, and — since Draft Receipt Email
        // folded into Bank Reconciliation's own gate — the receipt itself
        // once every new entry has.
        return this.isBankReconciled(context)
          ? this.draftReceiptTemplate(context)
          : this.bankReconciliationTemplate(context);
      case 'node-6':
        // The same step answers two kinds of thread: one that carried no payment
        // at all, and one whose every payment turned out to be already on the
        // books. What is being said back is different, so the template is too.
        return this.isAllDuplicate(context)
          ? this.duplicatePaymentTemplate(context)
          : this.nonPaymentTemplate(context);
      case 'node-11':
        return this.finalEmailResponseTemplate(context);
      default:
        return null;
    }
  }

  /**
   * The thread's Customer Sender, as an address on its own.
   *
   * The column often carries a display name too ("Dibya Kumari
   * &lt;dvshrm627@gmail.com&gt;"), which no mail client will accept in a To
   * field, so the address is taken out of the angle brackets when they are there.
   *
   * Public because the blank Draft Email compose fills its own To from here
   * as well — it is drafted by no step, so it never passes through forStep()
   * above, and a second copy of this parsing is a second thing to get wrong.
   */
  recipient(row: EmailReceiptRow): string {
    const sender = (row.customerSender || '').trim();
    const bracketed = sender.match(/<([^>]+)>/);

    return (bracketed ? bracketed[1] : sender).trim();
  }

  /**
   * The mailbox this reply goes out from: config.json's FromEmail when it is
   * set, for every thread and every step. Otherwise the thread's own owner
   * where it has one, and the CRM head where it does not.
   *
   * main_email_receipts.[Assigned To] holds the executive's *name* as
   * config.json spells it ("KAILASH D"), not an address, so it is resolved
   * through the same users[] list the assignment was made from. Two things send
   * it to the CRM head: a blank column — Unit Match has not settled the thread
   * yet, so nobody owns it — and a name config.json no longer lists, which would
   * otherwise leave the From box empty for a thread that does have an owner.
   *
   * Public for the same reason recipient() is: the blank Draft Email compose
   * fills its own From from here rather than keeping a second copy of the rule.
   */
  sender(row: EmailReceiptRow): string {
    const fromEmail = this.config.fromEmail;

    if (fromEmail) {
      return fromEmail;
    }

    const assignedTo = (row.assignedTo || '').trim();
    const mailbox = assignedTo ? this.config.getEmailForUser(assignedTo) : '';

    return (mailbox || this.config.fallbackUser.emailId || '').trim();
  }

  // ── One template per step ─────────────────────────────────────

  /**
   * Node 1: the ticket has been raised — tell the customer its number.
   *
   * The only template that answers nothing and asks for nothing: it exists so
   * the customer has a reference to quote, and knows the clock has started. Sent
   * as soon as the ticket exists, before any step has looked at the payment.
   */
  private ticketAcknowledgementTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;
    const ticketId = this.orDash(context.ticketId);

    return this.template(
      'node-1',
      'Ticket Acknowledgement',
      `We have received your email — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for writing to us. This email confirms that we have received your request and ' +
          'logged it with our Customer Relationship Management team.',
        '',
        `Your ticket ID for this request is ${ticketId}.`,
        '',
        'Details on our records:',
        `  • Ticket ID    : ${ticketId}`,
        `  • Subject      : ${this.orDash(row.emailSubject)}`,
        `  • Unit         : ${this.orDash(row.unit)}`,
        `  • Project      : ${this.orDash(row.project)}`,
        '',
        'Our team is reviewing your request and will come back to you within 12 hours.',
        '',
        this.signOff(context),
      ]
    );
  }

  /** Node 2: the sender address is not on any booking in the master. */
  private customerEmailTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;

    return this.template(
      'node-2',
      'Customer Email Verification',
      `Unable to verify your registered email address — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for writing to us regarding your payment.',
        '',
        `We tried to match the email address you wrote in from (${row.customerSender || 'your email address'}) ` +
          'against the address registered on your booking, and could not find it on our records.',
        '',
        'So that we can proceed, please reply to this email with:',
        '  1. The email address registered against your booking at the time of purchase',
        '  2. Your booking / application number',
        `  3. The unit number this payment relates to${this.unitSuffix(row)}`,
        '',
        'Once we have these, we will verify your details and carry on with the receipt.',
        '',
        this.signOff(context),
      ]
    );
  }

  /** Node 3: project/unit on the mail does not match the booking master. */
  private unitMatchTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;

    return this.template(
      'node-3',
      'Unit Match',
      `Unit details need confirming — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for writing to us regarding your payment.',
        '',
        'We could not match the unit details in your email against our booking records.',
        '',
        'What we have from your email:',
        `  • Project      : ${this.orDash(row.project)}`,
        `  • Sub Project  : ${this.orDash(row.subProject)}`,
        `  • Unit         : ${this.orDash(row.unit)}`,
        '',
        'Please reply confirming the correct project, wing/building and unit number as they appear on your ' +
          'allotment letter or agreement, and attach a copy of the letter if you have it to hand.',
        '',
        'We will update our records and continue with the receipt as soon as we hear back.',
        '',
        this.signOff(context),
      ]
    );
  }

  /** Node 4: the instrument/UTR was not found in the bank statements. */
  private instrumentMatchTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;

    return this.template(
      'node-4',
      'Instrument Match',
      `Payment reference not traced — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for sharing your payment details.',
        '',
        'We searched our bank statements for the payment reference you sent and could not trace it. ' +
          'The reference may have been mistyped, or the payment may not have reached the collection account yet.',
        '',
        'Payment details as we received them:',
        ...this.paymentLines(context.payments),
        '',
        'Please reply with:',
        '  1. The correct UTR / instrument number for this payment',
        '  2. The bank and account number the payment was made from',
        '  3. A copy of the bank advice or transaction screenshot showing the payment',
        '',
        'We will re-check the statements as soon as we have these.',
        '',
        this.signOff(context),
      ]
    );
  }

  /** Node 5: the payment was found but does not reconcile, or looks duplicated. */
  private bankReconciliationTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;

    return this.template(
      'node-5',
      'Bank Reconciliation',
      `Payment could not be reconciled — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for sharing your payment details.',
        '',
        'We traced your payment reference in our bank statements, but the details do not reconcile against ' +
          'what was received — the amount, the paying account or the reference itself differs from our record, ' +
          'or the same payment appears more than once.',
        '',
        'Payment details as we received them:',
        ...this.paymentLines(context.payments),
        '',
        'Please reply confirming:',
        '  1. The exact amount debited from your account, and the date it was debited',
        '  2. The UTR / instrument number against that debit',
        '  3. The account number the payment was made from',
        '  4. A copy of the bank statement entry for the payment',
        '',
        'We will reconcile it against our records as soon as we have these.',
        '',
        this.signOff(context),
      ]
    );
  }

  /**
   * Node 6: a non-payment thread — a document request, a statement ask, a query.
   *
   * There is no payment to trace here, so the template answers the customer
   * rather than asking them for anything: the document goes out with the reply
   * and the ticket closes on it. A new question means a new thread, and so a new
   * ticket, which is what the last line asks for.
   */
  private nonPaymentTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;
    const subject = (row.emailSubject || '').trim();

    return this.template(
      'node-6',
      'Email Response',
      subject ? `Re: ${subject}` : `Your query — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for writing to us.',
        '',
        `We have received your request${subject ? ` regarding "${subject}"` : ''} and it has been ` +
          `logged under ticket ${this.orDash(context.ticketId)}.`,
        '',
        'Your booking details on our records:',
        `  • Project      : ${this.orDash(row.project)}`,
        `  • Sub Project  : ${this.orDash(row.subProject)}`,
        `  • Unit         : ${this.orDash(row.unit)}`,
        '',
        // Swapped for TicketOpenLine when the reviewer answers "No" to
        // "Close this ticket?" in the popup.
        EmailResponseTemplateService.TicketClosedLine,
        '',
        'In case of any other further query, please send out a separate e-mail.',
        '',
        this.signOff(context),
      ],
      // The only reply that ends the matter, so the only one that offers to
      // close the ticket.
      true
    );
  }

  /**
   * Nodes a1-a13: one reply per Agreement Workflow stage.
   *
   * Each stage tells the customer where their agreement now stands, so the
   * bodies differ — the sentence in the middle is the stage's own, taken from
   * AGREEMENT_STAGE_COPY below. What surrounds it does not: the greeting, the
   * booking block and the sign-off are the same in every one, because they are
   * the same facts about the same thread.
   *
   * None of them can close the ticket. The agreement is still in progress at
   * every one of the thirteen — the reply that ends the thread is node 6, after
   * the last of them has passed.
   */
  private agreementStepTemplate(
    step: AgreementStep,
    context: EmailResponseContext
  ): EmailResponseTemplate {
    const { row } = context;
    const subject = (row.emailSubject || '').trim();
    const copy = AGREEMENT_STAGE_COPY[step.stepKey];

    return this.template(
      step.nodeId,
      step.title,
      subject ? `Re: ${subject} — ${copy.subject}` : `${copy.subject} — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        `This is an update on your agreement, logged under ticket ${this.orDash(context.ticketId)}.`,
        '',
        ...copy.lines,
        '',
        'Your booking details on our records:',
        `  • Project      : ${this.orDash(row.project)}`,
        `  • Sub Project  : ${this.orDash(row.subProject)}`,
        `  • Unit         : ${this.orDash(row.unit)}`,
        '',
        // Deliberately not TicketClosedLine: the agreement is still in
        // progress, and the thirteenth stage is not the end of the thread
        // either - node 6's reply is.
        EmailResponseTemplateService.TicketOpenLine,
        '',
        this.signOff(context),
      ]
    );
  }

  /**
   * True once every new entry on the thread reconciled against the bank
   * statement — Bank Reconciliation's own terminal state, folded in from what
   * used to be the separate Draft Receipt Email step. False while any new
   * entry is still unreconciled, which is the "please clarify" case node-5
   * otherwise answers.
   */
  private isBankReconciled(context: EmailResponseContext): boolean {
    const newEntries = context.payments.filter(
      (payment) => (payment.dublicateMatch || '').trim().toLowerCase() !== 'match'
    );

    return (
      newEntries.length > 0 &&
      newEntries.every((payment) => (payment.bankRecoMatch || '').trim().toLowerCase() === 'match')
    );
  }

  /**
   * True when the thread carries payments and every one of them is already on
   * the books — the case the pipeline ends at Email Response for.
   */
  private isAllDuplicate(context: EmailResponseContext): boolean {
    return (
      context.payments.length > 0 &&
      context.payments.every(
        (payment) => (payment.dublicateMatch || '').trim().toLowerCase() === 'match'
      )
    );
  }

  /**
   * Node 6, on a payment thread whose payments are all already receipted.
   *
   * Nothing is being asked for and nothing new is being receipted: the money is
   * on the account already, and the reply says so payment by payment. Each line
   * carries that payment's entry status, which for one the reviewer turned off
   * by hand is the reason they typed — so the customer is told the same thing
   * the record holds, not a generic "already received".
   */
  private duplicatePaymentTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row, payments } = context;
    const many = payments.length > 1;

    return this.template(
      'node-6',
      'Email Response',
      `Payment already received — Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for writing to us regarding your payment.',
        '',
        many
          ? 'We have checked the payments in your email against our receipts, and they are already ' +
            'recorded against your account. No further action is needed from you.'
          : 'We have checked the payment in your email against our receipts, and it is already ' +
            'recorded against your account. No further action is needed from you.',
        '',
        'Your booking details on our records:',
        `  • Project      : ${this.orDash(row.project)}`,
        `  • Sub Project  : ${this.orDash(row.subProject)}`,
        `  • Unit         : ${this.orDash(row.unit)}`,
        '',
        many ? 'Payments already on our records:' : 'The payment already on our records:',
        ...this.duplicatePaymentLines(payments),
        '',
        // Swapped for TicketOpenLine when the reviewer answers "No" to
        // "Close this ticket?" in the popup.
        EmailResponseTemplateService.TicketClosedLine,
        '',
        'In case of any other further query, please send out a separate e-mail.',
        '',
        this.signOff(context),
      ],
      // Nothing is outstanding, so this reply can end the matter.
      true
    );
  }

  /**
   * One line per payment, each carrying what the record says about it — the
   * step's own "Duplicate Entry", or the reason a reviewer typed when they
   * marked it themselves.
   */
  private duplicatePaymentLines(payments: EmailReceiptDetailRow[]): string[] {
    return payments.map((payment, index) => {
      const number = payment.paymentNo || `${index + 1}`;
      const amount = this.orDash(payment.amount);
      const instrument = this.orDash(payment.instrumentNumber);
      const status = (payment.entryStatus || '').trim() || 'Duplicate Entry';

      return (
        `  • Payment ${number} — Amount: ${amount} | UTR / Instrument No: ${instrument} | ` +
        `Status: ${status}`
      );
    });
  }

  /**
   * The receipt itself — Bank Reconciliation's terminal state, reachable only
   * once Customer Email Verification, Unit Match, Instrument Match and Bank
   * Reconciliation have all passed, so the wording can state the payment as
   * confirmed rather than hedging it. Used to be its own step (Draft Receipt
   * Email); see isBankReconciled() for how node-5 now tells the two apart.
   */
  private draftReceiptTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;

    return this.template(
      'node-5',
      'Bank Reconciliation',
      `Payment received — receipt for Unit ${this.orDash(row.unit)}, Ticket ${context.ticketId || 'raised'}`,
      [
        this.greeting(row),
        '',
        'Thank you for your payment.',
        '',
        'We are pleased to confirm that your payment has been verified against our bank records and applied ' +
          'to your account. The details are below.',
        '',
        `  • Project      : ${this.orDash(row.project)}`,
        `  • Sub Project  : ${this.orDash(row.subProject)}`,
        `  • Unit         : ${this.orDash(row.unit)}`,
        `  • Ticket       : ${this.orDash(context.ticketId)}`,
        '',
        'Payment(s) received:',
        ...this.paymentLines(context.payments),
        '',
        'Your receipt is attached. Please keep it for your records — you will need it for possession ' +
          'formalities and for your own tax filing.',
        '',
        'If anything above does not match your records, reply to this email and we will look into it.',
        '',
        this.signOff(context),
      ]
    );
  }

  /**
   * Node 11: the closing email after Info Receipt, for a genuinely reconciled
   * payment thread. The receipt itself already went out from node 5's own
   * gate — this confirms the RPA/ledger side has since caught up, and is the
   * one message on this route that offers to close the ticket. A non-payment
   * thread and an all-duplicate one never reach this template: their own
   * node-6 reply already closes the ticket, which is why node 11 is hidden
   * for both (see getWorkflowNodes()'s nonPaymentSteps / duplicateOnlySteps).
   */
  private finalEmailResponseTemplate(context: EmailResponseContext): EmailResponseTemplate {
    const { row } = context;

    return this.template(
      'node-11',
      'Final Email Response',
      `Payment confirmed — Ticket ${context.ticketId || 'raised'} closed`,
      [
        this.greeting(row),
        '',
        'Thank you again for your payment.',
        '',
        'This confirms your payment has been fully processed and posted against your account, and the ' +
          'receipt shared earlier now reflects on our records.',
        '',
        `  • Project      : ${this.orDash(row.project)}`,
        `  • Sub Project  : ${this.orDash(row.subProject)}`,
        `  • Unit         : ${this.orDash(row.unit)}`,
        `  • Ticket       : ${this.orDash(context.ticketId)}`,
        '',
        'Payment(s) confirmed:',
        ...this.paymentLines(context.payments),
        '',
        // Swapped for TicketOpenLine when the reviewer answers "No" to
        // "Close this ticket?" in the popup.
        EmailResponseTemplateService.TicketClosedLine,
        '',
        'In case of any other further query, please send out a separate e-mail.',
        '',
        this.signOff(context),
      ],
      // The pipeline's true last word on this route, so this is the one
      // reply on it that offers to close the ticket.
      true
    );
  }

  // ── Shared pieces ─────────────────────────────────────────────

  /**
   * The two versions of the ticket-status line, swapped in the popup by the
   * answer to "Close this ticket?".
   *
   * Written out in full rather than composed, because the swap is a plain
   * string replace on the drafted body: the sentence the reviewer sees has to be
   * the sentence the code looks for.
   */
  static readonly TicketClosedLine =
    'Your ticket is closed. We have shared the document with you.';

  static readonly TicketOpenLine =
    'Your ticket is open. Our team is working on your request and will come back to you shortly.';

  private template(
    stepId: WorkflowStepId,
    stepTitle: string,
    subject: string,
    body: string[],
    canCloseTicket = false
  ): EmailResponseTemplate {
    return {
      stepId,
      stepTitle,
      // Both address rows are filled in by forStep(): `from` from the thread's
      // Assigned To owner, `to` from its Customer Sender. So are the two ids
      // the saved reply is filed under.
      from: '',
      to: '',
      threadId: '',
      ticketId: '',
      subject,
      body: body.join('\n'),
      canCloseTicket,
      ticketClosedLine: EmailResponseTemplateService.TicketClosedLine,
      ticketOpenLine: EmailResponseTemplateService.TicketOpenLine,
    };
  }

  private greeting(row: EmailReceiptRow): string {
    const name = (row.customerName || '').trim();

    return name ? `Dear ${name},` : 'Dear Sir / Madam,';
  }

  /** One line per payment, so the customer can see exactly what we are querying. */
  private paymentLines(payments: EmailReceiptDetailRow[]): string[] {
    if (!payments.length) {
      return ['  • (no payment rows were read from this email)'];
    }

    return payments.map((payment, index) => {
      const number = payment.paymentNo || `${index + 1}`;
      const amount = this.orDash(payment.amount);
      const mode = this.orDash(payment.paymentMode);
      const instrument = this.orDash(payment.instrumentNumber);

      return `  • Payment ${number} — Amount: ${amount} | Mode: ${mode} | UTR / Instrument No: ${instrument}`;
    });
  }

  /** Unit is often blank on exactly the threads that stop at node 2. */
  private unitSuffix(row: EmailReceiptRow): string {
    const unit = (row.unit || '').trim();

    return unit ? ` (our records show Unit ${unit})` : '';
  }

  private signOff(context: EmailResponseContext): string {
    return [
      'Regards,',
      'Customer Relationship Management',
      'Pride Group',
      '',
      `Ticket reference: ${this.orDash(context.ticketId)} — please quote this in your reply.`,
    ].join('\n');
  }

  private orDash(value: string | undefined): string {
    const trimmed = (value || '').trim();
    const placeholders = ['n/a', 'na', 'none', 'null', '-', '--'];

    return trimmed === '' || placeholders.indexOf(trimmed.toLowerCase()) !== -1 ? '—' : trimmed;
  }
}
