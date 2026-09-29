/**
 * The Agreement Workflow: the thirteen stages a Non-Payment - Customer thread
 * about an agreement runs through, between Unit Match and the reply that ends
 * it.
 *
 * A thread only has these stages when all three of the following hold:
 *
 *     Category   is 'Non-Payment - Customer'
 *     Intent     is 'Agreement'
 *     Sub-Intent is 'Agreement'
 *
 * 'Non-Payment - System' was included at first; the client has since scoped the
 * stages to customer-raised threads, so a system-raised one keeps its two-step
 * route (ticket, then reply) whatever its intent says.
 *
 * Any other combination keeps the pipeline it has today. See
 * WorkflowVisualizer.isAgreementThread, which is the one place that test is
 * made on this side, and IsAgreementThread in EmailAutomationController, which
 * makes the same test before it will write anything.
 *
 * This file is the single source of truth for the stages. The pipeline nodes,
 * the Thread Details cards, the email templates, the dashboard's stage columns
 * and the API calls are all built by walking AGREEMENT_STEPS — nothing
 * re-types the list, and nothing hard-codes a stage's node id.
 */

/** Node ids for the thirteen stages, in pipeline order. */
export type AgreementNodeId =
  | 'node-a1'
  | 'node-a2'
  | 'node-a3'
  | 'node-a4'
  | 'node-a5'
  | 'node-a6'
  | 'node-a7'
  | 'node-a8'
  | 'node-a9'
  | 'node-a10'
  | 'node-a11'
  | 'node-a12'
  | 'node-a13';

/** One stage of the Agreement Workflow. */
export interface AgreementStep {
  /**
   * The pipeline node this stage draws as.
   *
   * Prefixed 'node-a' rather than numbered on from the payment pipeline: its
   * node-11 is Final Email Response and has nothing to do with this workflow's
   * eleventh stage, and two steps answering to one id would be a real
   * collision, not a cosmetic one.
   */
  nodeId: AgreementNodeId;

  /**
   * What the backend is called with, and the key its verdict and stamp come
   * back under in `agreementSteps` / `agreementStepDates` on the receipt row.
   *
   * The DB columns behind those are snake_case and spaceless
   * ([Booking_KYC_Verification], [Booking_KYC_Verification_Date] and the rest),
   * but no column name ever reaches this side — AgreementSteps in
   * EmailAutomationController maps a step key to its column, and only it knows
   * the spelling.
   */
  stepKey: string;

  /** The stage's name, on its pipeline card and its Thread Details card. */
  title: string;

  /**
   * The one thing this stage is: "Booking Form & KYC Validation", "Payment
   * Entry". Short enough for the line under the title on the pipeline card,
   * which is where it is drawn.
   */
  keyActivity: string;

  /**
   * What the stage involves, in full, as the process document words it.
   *
   * Kept apart from keyActivity rather than folded into it: the pipeline card
   * has one line to spare and the Thread Details card has room for the whole
   * thing, so the two need different lengths of the same fact.
   */
  description: string;

  /**
   * The stage's own icon, as the `d` of one or more 24x24 stroke paths.
   *
   * Path data rather than a component or a sprite id, because the card draws
   * the <svg> itself and only the shapes differ — stroke, size and colour are
   * the same on all thirteen and belong to the template, not to the list.
   * Every shape is expressed as a path, including the round ones, so the card
   * needs a single <path *ngFor> and never a per-icon branch.
   *
   * Thirteen stacked cards all carrying the same document glyph gave the eye
   * nothing to tell them apart by, so each stage draws what it is about.
   */
  iconPaths: string[];
}

/**
 * The thirteen stages, in the order they run. Order is load-bearing: a stage is
 * blocked until the one before it in this array has passed, on both sides.
 */
export const AGREEMENT_STEPS: readonly AgreementStep[] = [
  {
    nodeId: 'node-a1',
    stepKey: 'booking-kyc',
    title: 'Booking & KYC Verification',
    keyActivity: 'Booking Form & KYC Validation',
    description:
      'Verify booking application, customer details and KYC documents, and ensure all required information is accurately updated in ERP.',
    iconPaths: [
      'M3 5.5h18v13H3z',
      'M9 11.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
      'M6 16c.7-1.5 1.9-2.3 3-2.3s2.3.8 3 2.3',
      'M15 9.5h3.5',
      'M15 13h3.5',
    ],
  },
  {
    nodeId: 'node-a2',
    stepKey: 'agreement-drafting',
    title: 'Agreement Drafting',
    keyActivity: 'Agreement Draft Download & Dispatch',
    description:
      'Download the agreement draft from the ERP system and share it with the customer for review and confirmation.',
    iconPaths: [
      'M4 20h4L18 10l-4-4L4 16z',
      'M13.5 6.5 17.5 10.5',
      'M3 22h18',
    ],
  },
  {
    nodeId: 'node-a3',
    stepKey: 'sdr-bsl-coordination',
    title: 'SDR / BSL Coordination',
    keyActivity: 'Process Follow-up',
    description:
      'Coordinate with the customer for stamp duty, registration and BSL related requirements.',
    iconPaths: [
      'M8 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
      'M2 20.5c0-3.3 2.7-5 6-5s6 1.7 6 5',
      'M17.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
      'M16.5 13.5c3 0 5.5 1.5 5.5 4.5',
    ],
  },
  {
    nodeId: 'node-a4',
    stepKey: 'agreement-approval',
    title: 'Agreement Approval',
    keyActivity: 'Customer Confirmation',
    description:
      'Follow up with the customer for review, confirmation and approval of the agreement draft.',
    iconPaths: [
      'M12 15.5a6 6 0 1 0 0-12 6 6 0 0 0 0 12',
      'M9.5 9.5l1.8 1.8 3.2-3.3',
      'M8.5 14.5 7 22l5-2.6L17 22l-1.5-7.5',
    ],
  },
  {
    nodeId: 'node-a5',
    stepKey: 'payment-erp-update',
    title: 'Payment & ERP Update',
    keyActivity: 'Payment Entry',
    description:
      'Verify receipt of the customer payment and create the corresponding payment entry in ERP.',
    iconPaths: [
      'M2 6.5h20v11H2z',
      'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
      'M5.5 9.5v5',
      'M18.5 9.5v5',
    ],
  },
  {
    nodeId: 'node-a6',
    stepKey: 'document-preparation',
    title: 'Document Preparation',
    keyActivity: 'Printing & Document Compilation',
    description:
      'Print the required documents after completion of the necessary checks and approvals.',
    iconPaths: [
      'M9 2.5h6L20 7v10.5A1.5 1.5 0 0 1 18.5 19H9a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 9 2.5z',
      'M15 2.5V7h5',
      'M4.5 6.5v13A1.5 1.5 0 0 0 6 21h9',
    ],
  },
  {
    nodeId: 'node-a7',
    stepKey: 'agreement-execution',
    title: 'Agreement Execution / Signature',
    keyActivity: 'Customer Signing Coordination',
    description:
      'Send mail to the customer and coordinate the agreement signing process, along with the consent form and the other documents.',
    iconPaths: [
      'M3 17.5c3 0 3.5-9 6.5-9s1.5 9 4.5 9 2.5-5 4.5-5',
      'M3 21.5h18',
    ],
  },
  {
    nodeId: 'node-a8',
    stepKey: 'stamp-duty-challan',
    title: 'Stamp Duty Challan',
    keyActivity: 'Challan Request to Accounts',
    description:
      'Prepare and forward the stamp duty challan request, with the required details, to the Accounts Department.',
    iconPaths: [
      'M9 3.5h6a2 2 0 0 1 2 2c0 2.5-2 3-2 5H9c0-2-2-2.5-2-5a2 2 0 0 1 2-2z',
      'M5 15.5h14v3H5z',
      'M3.5 21.5h17',
    ],
  },
  {
    nodeId: 'node-a9',
    stepKey: 'registration-data',
    title: 'Registration Data Processing',
    keyActivity: 'Data Entry',
    description:
      'Share the required customer, property and registration details with Anand Purane for data entry and further processing.',
    iconPaths: [
      'M12 7.5c4.4 0 8-1.1 8-2.5S16.4 2.5 12 2.5 4 3.6 4 5s3.6 2.5 8 2.5z',
      'M20 5v14c0 1.4-3.6 2.5-8 2.5S4 20.4 4 19V5',
      'M20 12c0 1.4-3.6 2.5-8 2.5S4 13.4 4 12',
    ],
  },
  {
    nodeId: 'node-a10',
    stepKey: 'registration-scheduling',
    title: 'Registration Scheduling',
    keyActivity: 'Date Confirmation',
    description:
      'Coordinate and confirm the registration date, and communicate the confirmed date to the customer.',
    iconPaths: [
      'M4 5.5h16v15H4z',
      'M4 10h16',
      'M8 3v4',
      'M16 3v4',
      'M12 13v3l2.2 1.3',
    ],
  },
  {
    nodeId: 'node-a11',
    stepKey: 'ho-signature',
    title: 'HO Signature Process',
    keyActivity: 'Anand Jain Signature',
    description:
      "Forward the agreement and documentation to Head Office for Anand Jain's signature, and track the completion of the process.",
    iconPaths: [
      'M4 21V4.5A1.5 1.5 0 0 1 5.5 3h8A1.5 1.5 0 0 1 15 4.5V21',
      'M15 10h3.5A1.5 1.5 0 0 1 20 11.5V21',
      'M2.5 21h19',
      'M7.5 7h4',
      'M7.5 11h4',
      'M7.5 15h4',
    ],
  },
  {
    nodeId: 'node-a12',
    stepKey: 'registration-appointment',
    title: 'Registration Appointment',
    keyActivity: 'Customer Appointment & Final Communication',
    description:
      'Share the registration appointment details with the customer and provide the necessary information regarding the registration process.',
    iconPaths: [
      'M12 21.5s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z',
      'M12 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
    ],
  },
  {
    nodeId: 'node-a13',
    stepKey: 'ghoshvara-verification',
    title: 'Ghoshvara Verification',
    keyActivity: 'Data Entry / Ghoshvara Verification',
    description:
      'Verify the Ghoshvara record against the registered documents.',
    iconPaths: [
      'M12 2.5 20 5.5v6c0 4.6-3.3 8.4-8 9.9-4.7-1.5-8-5.3-8-9.9v-6z',
      'M8.8 11.8 11 14l4.3-4.4',
    ],
  },
];

/** The stages' node ids, in order — handy for the pipeline's route filters. */
export const AGREEMENT_NODE_IDS: readonly string[] = AGREEMENT_STEPS.map((step) => step.nodeId);

/** The stage drawn as one node id, or undefined when the id is not one of ours. */
export function agreementStepByNodeId(nodeId: string): AgreementStep | undefined {
  return AGREEMENT_STEPS.find((step) => step.nodeId === nodeId);
}

/** The stage after `nodeId`, or undefined after the thirteenth. */
export function nextAgreementStep(nodeId: string): AgreementStep | undefined {
  const index = AGREEMENT_STEPS.findIndex((step) => step.nodeId === nodeId);

  return index === -1 ? undefined : AGREEMENT_STEPS[index + 1];
}

/** The stage before `nodeId`, or undefined for the first — nothing blocks it. */
export function previousAgreementStep(nodeId: string): AgreementStep | undefined {
  const index = AGREEMENT_STEPS.findIndex((step) => step.nodeId === nodeId);

  return index <= 0 ? undefined : AGREEMENT_STEPS[index - 1];
}
