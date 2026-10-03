import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AppConfig } from '../models/app-config.model';
import { ConfigService } from './config.service';
import { SlotAssignmentService } from './slot-assignment.service';

/**
 * A cut-down config.json carrying the parts the rule reads: slotted users, the
 * booking statuses staged under each slot, and project mappings with one owner
 * per sub-project — one of which (RIO TOWER / J → PIYUSH) names a user who
 * holds no slot at all, the way the live file does.
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
    { company: 'PRIDE', projectName: 'WELLINGTON - E-H-J-K', subProject: 'K', users: ['RITA'] },
    { company: 'PRIDE', projectName: 'WELLINGTON - E-H-J-K', subProject: 'E', users: ['SONAL'] },
    { company: 'PRIDE', projectName: 'WELLINGTON - E-H-J-K', subProject: 'H', users: ['SURAJ'] },
    { company: 'PRIDE', projectName: 'SOHO', users: ['NAMRATA'] },
    { company: 'CHARHOLI', projectName: 'RIO TOWER', subProject: 'J', users: ['PIYUSH'] },
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
    it("takes the sub-project's mapped owner when they work that stage", () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'TRANSACTION FORM',
        project: 'WELLINGTON',
        subProject: 'E',
      });

      expect(decision.user).toEqual({ name: 'SONAL', emailId: 'CRM3@TEST.LOCAL' });
      expect(decision.slot).toBe('Pre-Agreement');
      expect(decision.reason).toBe('slot-mapping');
      expect(decision.pool).toEqual(['SONAL']);
    });

    it('gives the same answer every time, whatever thread it is run for', () => {
      const run = () =>
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'ALLOTMENT LETTER',
          project: 'WELLINGTON',
          subProject: 'E',
        }).user.name;

      expect(run()).toBe('SONAL');
      expect(run()).toBe('SONAL');
    });

    it("gives it to the CRM head when the sub-project's owner works a later stage", () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'TRANSACTION FORM',
        project: 'WELLINGTON',
        subProject: 'K',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('no-slot-user');
      expect(decision.pool).toEqual(['RITA']);
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

    it('gives it to the CRM head when the mapped user holds no slot', () => {
      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'TRANSACTION FORM',
        project: 'RIO TOWER',
        subProject: 'J',
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
        subProject: 'E',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('no-slot-user');
      expect(decision.slot).toBe('Pre-Agreement');
    });
  });

  describe('Post-Agreement', () => {
    it('gives each sub-project of one project to its own owner', () => {
      const ownerOf = (subProject: string) =>
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'DOCUMENT HANDOVER',
          project: 'WELLINGTON',
          subProject,
        });

      expect(ownerOf('K').user).toEqual({ name: 'RITA', emailId: 'RITA@TEST.LOCAL' });
      expect(ownerOf('K').reason).toBe('slot-mapping');
      expect(ownerOf('H').user).toEqual({ name: 'SURAJ', emailId: 'CRM7@TEST.LOCAL' });
    });

    it('gives it to the CRM head when the sub-project is not listed', () => {
      for (const subProject of ['J', '', undefined]) {
        const decision = service.resolve({
          unitMatched: true,
          bookingStatusName: 'DOCUMENT HANDOVER',
          project: 'WELLINGTON',
          subProject,
        });

        expect(decision.user.name).toBe('CRM_Head');
        expect(decision.reason).toBe('no-slot-user');
      }
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

    it('still reads the wings off projectName for an entry without subProject', async () => {
      await load({
        ...CONFIG,
        projectMappings: [{ company: 'PRIDE', projectName: 'WELLINGTON - E-H-J-K', users: ['RITA'] }],
      });

      expect(
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'DOCUMENT HANDOVER',
          project: 'WELLINGTON',
          subProject: 'J',
        }).user.name
      ).toBe('RITA');
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

      // SOHO lists no sub-project, so it covers the whole project.
      expect(
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'FILE BINDING DONE',
          project: 'SOHO',
        }).user.name
      ).toBe('NAMRATA');
    });
  });

  describe('more than one owner for a sub-project', () => {
    it('picks nobody: the CRM head holds it and a reviewer decides', async () => {
      await load({
        ...CONFIG,
        users: [
          ...(CONFIG.users ?? []),
          { name: 'MEERA', emailId: 'MEERA@TEST.LOCAL', Slot: 'Post-Agreement' },
        ],
        projectMappings: [
          { company: 'PRIDE', projectName: 'WELLINGTON - E-H-J-K', subProject: 'K', users: ['RITA'] },
          { company: 'PRIDE', projectName: 'WELLINGTON - E-H-J-K', subProject: 'K', users: ['MEERA'] },
        ],
      });

      const decision = service.resolve({
        unitMatched: true,
        bookingStatusName: 'DOCUMENT HANDOVER',
        project: 'WELLINGTON',
        subProject: 'K',
      });

      expect(decision.user.name).toBe('CRM_Head');
      expect(decision.reason).toBe('multiple-owners');
      expect(decision.needsIntervention).toBe(true);
      expect(decision.pool).toEqual(['RITA', 'MEERA']);
    });

    it('does not count the same user listed twice as two owners', async () => {
      await load({
        ...CONFIG,
        projectMappings: [
          { company: 'PRIDE', projectName: 'WELLINGTON - E-H-J-K', subProject: 'K', users: ['RITA'] },
          { company: 'PRIDE', projectName: 'WELLINGTON', subProject: 'K', users: ['rita '] },
        ],
      });

      expect(
        service.resolve({
          unitMatched: true,
          bookingStatusName: 'DOCUMENT HANDOVER',
          project: 'WELLINGTON',
          subProject: 'K',
        }).user.name
      ).toBe('RITA');
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
