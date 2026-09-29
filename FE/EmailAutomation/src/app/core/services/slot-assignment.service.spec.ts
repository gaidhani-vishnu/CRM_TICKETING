import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AppConfig } from '../models/app-config.model';
import { ConfigService } from './config.service';
import { SlotAssignmentService } from './slot-assignment.service';

/**
 * A cut-down config.json carrying the parts the rule reads: slotted users, the
 * booking statuses staged under each slot, and a few project mappings — one of
 * which (RIO TOWER → PIYUSH) lists a user who holds no slot at all, the way the
 * live file does.
 */
const CONFIG: AppConfig = {
  apiBaseUrl: 'http://test.local/api',
  environmentName: 'test',
  appName: 'Pride Email Automation',
  version: '1.0.0',
  fallbackUser: { name: 'CRM_Head', emailId: 'workflow@test.local' },
  users: [
    { name: 'NIKITA K.', emailId: 'CRM@TEST.LOCAL', Slot: 'Pre-Agreement' },
    { name: 'SONAL', emailId: 'CRM3@TEST.LOCAL', Slot: 'Pre-Agreement' },
    { name: 'AMIT', emailId: 'CRM11@TEST.LOCAL', Slot: 'Pre-Agreement' },
    { name: 'RITA', emailId: 'RITA@TEST.LOCAL', Slot: 'Post-Agreement' },
    { name: 'SURAJ', emailId: 'CRM7@TEST.LOCAL', Slot: 'Post-Agreement' },
    { name: 'NAMRATA', emailId: 'CRMHEAD@TEST.LOCAL', Slot: 'Post-Possession' },
    { name: 'PIYUSH', emailId: '' },
  ],
  projectMappings: [
    {
      company: 'PRIDE',
      projectName: 'WELLINGTON - E-H-J-K',
      users: ['NIKITA K.', 'SONAL', 'AMIT', 'RITA', 'SURAJ'],
    },
    { company: 'PRIDE', projectName: 'SOHO', users: ['SONAL', 'SURAJ', 'NAMRATA'] },
    { company: 'CHARHOLI', projectName: 'RIO TOWER', users: ['PIYUSH'] },
  ],
  bookingStatusSlots: {
    'Pre-Agreement': ['TRANSACTION FORM', 'ALLOTMENT LETTER / LOI'],
    'Post-Agreement': ['DOCUMENT HANDOVER', 'POSSESSION LETTER ISSUED'],
    'Post-Possession': ['FILE SENT FOR BINDING', 'FILE BINDING DONE'],
  },
};

describe('SlotAssignmentService', () => {
  let service: SlotAssignmentService;
  let config: ConfigService;
  let httpMock: HttpTestingController;

  async function load(loaded: AppConfig): Promise<void> {
    const loading = config.loadConfig();
    httpMock.expectOne((r) => r.url.startsWith('/config.json')).flush(loaded);
    await loading;
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    service = TestBed.inject(SlotAssignmentService);
    config = TestBed.inject(ConfigService);
    httpMock = TestBed.inject(HttpTestingController);

    await load(CONFIG);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('unit not matched', () => {
    it('gives the thread to the CRM head, as it did before slots existed', () => {
      const decision = service.resolve({
        unitMatched: false,
        bookingStatusName: 'FILE BINDING DONE',
        project: 'WELLINGTON',
        subProject: 'K',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.slot).toBeNull();
      expect(decision.reason).toBe('unit-unmatched');
      expect(decision.needsIntervention).toBe(false);
    });
  });

  describe('Pre-Agreement', () => {
    it('takes the first mapped user who works that stage', () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'TRANSACTION FORM',
        project: 'WELLINGTON',
        subProject: 'K',
      });

      expect(decision.user).toEqual({ name: 'NIKITA K.', emailId: 'CRM@TEST.LOCAL' });
      expect(decision.slot).toBe('Pre-Agreement');
      expect(decision.reason).toBe('slot-mapping');
    });

    it('gives the same answer every time, whatever thread it is run for', () => {
      const run = () =>
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'ALLOTMENT LETTER',
          project: 'WELLINGTON',
          subProject: 'K',
        }).user.name;

      expect(run()).toBe('NIKITA K.');
      expect(run()).toBe('NIKITA K.');
    });

    it('skips a mapped user whose slot is a later stage', () => {
      // SOHO lists SONAL (Pre), SURAJ (Post-Agreement) and NAMRATA (Post-Possession).
      expect(
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'TRANSACTION FORM',
          project: 'SOHO',
        }).user.name
      ).toBe('SONAL');
    });

    it('gives it to the CRM head when the project matches no mapping', () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'TRANSACTION FORM',
        project: 'SOMEWHERE ELSE',
        subProject: 'A',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('no-slot-user');
    });

    it('gives it to the CRM head when no mapped user works the early stage', () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'TRANSACTION FORM',
        project: 'RIO TOWER',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('no-slot-user');
      expect(decision.pool).toEqual(['PIYUSH']);
    });

    it('falls back to the CRM head when nobody holds the slot at all', async () => {
      await load({
        ...CONFIG,
        users: CONFIG.users?.filter((u) => u.Slot !== 'Pre-Agreement'),
      });

      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'TRANSACTION FORM',
        project: 'WELLINGTON',
        subProject: 'K',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('no-slot-user');
      expect(decision.slot).toBe('Pre-Agreement');
    });
  });

  describe('Post-Agreement', () => {
    it('takes the first mapped user who works that stage', () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'DOCUMENT HANDOVER',
        project: 'WELLINGTON',
        subProject: 'K',
      });

      expect(decision.user).toEqual({ name: 'RITA', emailId: 'RITA@TEST.LOCAL' });
      expect(decision.slot).toBe('Post-Agreement');
      expect(decision.reason).toBe('slot-mapping');
    });

    it('skips a mapped user whose slot is a different stage', () => {
      // SOHO lists SONAL (Pre), SURAJ (Post-Agreement) and NAMRATA (Post-Possession).
      expect(
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'POSSESSION LETTER ISSUED',
          project: 'SOHO',
        }).user.name
      ).toBe('SURAJ');
    });

    it('gives it to the CRM head when no mapped user works that stage', () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'DOCUMENT HANDOVER',
        project: 'RIO TOWER',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('no-slot-user');
      expect(decision.pool).toEqual(['PIYUSH']);
    });

    it('gives it to the CRM head when the project matches no mapping', () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'DOCUMENT HANDOVER',
        project: 'SOMEWHERE ELSE',
        subProject: 'A',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('no-slot-user');
    });
  });

  describe('Post-Possession', () => {
    it('checks the project mapping too, not just the slot', () => {
      // NAMRATA holds the slot but is not on WELLINGTON.
      expect(
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'FILE BINDING DONE',
          project: 'WELLINGTON',
          subProject: 'K',
        }).user.name
      ).toBe('CRM_Head');

      expect(
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'FILE BINDING DONE',
          project: 'SOHO',
        }).user.name
      ).toBe('NAMRATA');
    });

    it('supports more than one user in the slot, mapping order deciding', async () => {
      await load({
        ...CONFIG,
        users: [
          ...(CONFIG.users ?? []),
          { name: 'MEERA', emailId: 'MEERA@TEST.LOCAL', Slot: 'Post-Possession' },
        ],
        projectMappings: [
          { company: 'PRIDE', projectName: 'SOHO', users: ['MEERA', 'NAMRATA'] },
        ],
      });

      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'FILE SENT FOR BINDING',
        project: 'SOHO',
      });

      expect(decision.user.name).toBe('MEERA');
      expect(decision.slot).toBe('Post-Possession');
    });
  });

  describe('unknown booking status', () => {
    it('asks for a reviewer and parks the thread with the CRM head meanwhile', () => {
      for (const status of ['', '   ', '—', 'CANCELLED', null, undefined]) {
        const decision = service.resolve({
          unitMatched: true,
          bookingStatusName: status,
          project: 'WELLINGTON',
          subProject: 'K',
        });

        expect(decision.user.name).toBe('CRM_Head');
        expect(decision.slot).toBeNull();
        expect(decision.reason).toBe('unknown-status');
        expect(decision.needsIntervention).toBe(true);
      }
    });

    it('asks for a reviewer when config.json stages no statuses at all', async () => {
      await load({ ...CONFIG, bookingStatusSlots: undefined });

      expect(
        service.resolve({ unitMatched: true, bookingStatusName: 'FILE BINDING DONE' })
          .needsIntervention
      ).toBe(true);
    });
  });
});
