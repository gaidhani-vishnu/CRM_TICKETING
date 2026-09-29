import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ConfigService } from './config.service';
import { AppConfig } from '../models/app-config.model';

/**
 * The shape of config.json as far as user lookup cares: a master list, plus the
 * catch-all owner kept in its own section rather than in `users[]` — which is
 * exactly why getEmailForUser has to consult both.
 */
const CONFIG: AppConfig = {
  apiBaseUrl: 'http://test.local/api',
  environmentName: 'test',
  appName: 'Pride Email Automation',
  version: '1.0.0',
  users: [
    { name: 'KAILASH D', emailId: 'CRM2@PRIDEWORLDCITY.COM' },
    { name: 'SANJANA', emailId: 'CRM4@PRIDEWORLDCITY.COM' },
  ],
  fallbackUser: { name: 'CRM_Head', emailId: 'crm.head@test.local' },
};

describe('ConfigService.getEmailForUser', () => {
  let service: ConfigService;
  let httpMock: HttpTestingController;

  /** Runs the startup fetch and answers it with `config`. */
  async function load(config: AppConfig): Promise<void> {
    const loading = service.loadConfig();
    httpMock.expectOne((r) => r.url.startsWith('/config.json')).flush(config);
    await loading;
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    service = TestBed.inject(ConfigService);
    httpMock = TestBed.inject(HttpTestingController);

    await load(CONFIG);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('returns the mailbox of a user in the master list', () => {
    expect(service.getEmailForUser('KAILASH D')).toBe('CRM2@PRIDEWORLDCITY.COM');
    expect(service.getEmailForUser('SANJANA')).toBe('CRM4@PRIDEWORLDCITY.COM');
  });

  it('matches master-list names case-insensitively and ignores surrounding space', () => {
    expect(service.getEmailForUser('  kailash d  ')).toBe('CRM2@PRIDEWORLDCITY.COM');
  });

  it('falls through to the fallback user for CRM_Head, which is not in users[]', () => {
    expect(CONFIG.users?.some((u) => u.name === 'CRM_Head')).toBe(false);
    expect(service.getEmailForUser('CRM_Head')).toBe('crm.head@test.local');
  });

  it('matches the fallback user case-insensitively and ignores surrounding space', () => {
    expect(service.getEmailForUser('  crm_head  ')).toBe('crm.head@test.local');
  });

  it('still returns empty for a name that is in neither place', () => {
    expect(service.getEmailForUser('NOBODY')).toBe('');
  });

  it('returns empty for a blank name rather than leaking the fallback mailbox', () => {
    expect(service.getEmailForUser('')).toBe('');
    expect(service.getEmailForUser('   ')).toBe('');
    expect(service.getEmailForUser(null as unknown as string)).toBe('');
  });

  it('prefers the master list when a name appears in both', async () => {
    await load({
      ...CONFIG,
      users: [{ name: 'CRM_Head', emailId: 'roster@test.local' }],
    });

    expect(service.getEmailForUser('CRM_Head')).toBe('roster@test.local');
  });
});

/**
 * The slot sections as config.json carries them: a capital-S `Slot` on each
 * user, and the booking statuses grouped by the slot that handles them.
 */
const SLOT_CONFIG: AppConfig = {
  ...CONFIG,
  users: [
    { name: 'NIKITA K.', emailId: 'CRM@PRIDEWORLDCITY.COM', Slot: 'Pre-Agreement' },
    { name: 'SONAL', emailId: 'CRM3@PRIDEWORLDCITY.COM', Slot: 'Pre-Agreement' },
    { name: 'KAILASH D', emailId: 'CRM2@PRIDEWORLDCITY.COM', Slot: 'Post-Agreement' },
    { name: 'NAMRATA', emailId: 'CRMHEAD@PRIDEWORLDCITY.COM', Slot: 'Post-Possession' },
    // Slotless, the way PIYUSH is in the live file.
    { name: 'PIYUSH', emailId: '' },
  ],
  bookingStatusSlots: {
    'Pre-Agreement': ['TRANSACTION FORM', 'ALLOTMENT LETTER / LOI', 'BSL/OWN CONT. COLLECTED'],
    'Post-Agreement': ['DOCUMENT HANDOVER', 'INTIMATION OF PROVISIONAL POSSESSION / FINAL POSSESSION'],
    'Post-Possession': ['FILE SENT FOR BINDING', 'FILE BINDING DONE'],
  },
};

describe('ConfigService slots', () => {
  let service: ConfigService;
  let httpMock: HttpTestingController;

  async function load(config: AppConfig): Promise<void> {
    const loading = service.loadConfig();
    httpMock.expectOne((r) => r.url.startsWith('/config.json')).flush(config);
    await loading;
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    service = TestBed.inject(ConfigService);
    httpMock = TestBed.inject(HttpTestingController);

    await load(SLOT_CONFIG);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('reads the capital-S key config.json is written with', () => {
    expect(service.slotOf({ name: 'X', emailId: '', Slot: 'Post-Agreement' })).toBe('Post-Agreement');
  });

  it('tolerates a lower-case key and loose casing in the value', () => {
    expect(service.slotOf({ name: 'X', emailId: '', slot: 'post-possession' })).toBe('Post-Possession');
    expect(service.slotOf({ name: 'X', emailId: '', Slot: ' Pre Agreement ' })).toBe('Pre-Agreement');
  });

  it('returns null for a user with no slot or an unknown one', () => {
    expect(service.slotOf({ name: 'PIYUSH', emailId: '' })).toBeNull();
    expect(service.slotOf({ name: 'X', emailId: '', Slot: 'Handover' })).toBeNull();
    expect(service.slotOf(null)).toBeNull();
  });

  it('lists the users of a slot in config order and leaves the slotless out', () => {
    expect(service.usersInSlot('Pre-Agreement').map((u) => u.name)).toEqual(['NIKITA K.', 'SONAL']);
    expect(service.usersInSlot('Post-Possession').map((u) => u.name)).toEqual(['NAMRATA']);
  });

  it('never offers the fallback owner as a slot user', () => {
    const everyone = [
      ...service.usersInSlot('Pre-Agreement'),
      ...service.usersInSlot('Post-Agreement'),
      ...service.usersInSlot('Post-Possession'),
    ];

    expect(everyone.some((u) => u.name === 'CRM_Head')).toBe(false);
  });

  it('maps a booking status to its slot', () => {
    expect(service.slotForBookingStatus('TRANSACTION FORM')).toBe('Pre-Agreement');
    expect(service.slotForBookingStatus('DOCUMENT HANDOVER')).toBe('Post-Agreement');
    expect(service.slotForBookingStatus('FILE BINDING DONE')).toBe('Post-Possession');
  });

  it('ignores case, spacing and punctuation the exports are inconsistent about', () => {
    expect(service.slotForBookingStatus('  bsl/own cont. collected ')).toBe('Pre-Agreement');
    expect(service.slotForBookingStatus('BSL / OWN CONT COLLECTED')).toBe('Pre-Agreement');
  });

  it('matches either side of a spaced slash, which joins two status names', () => {
    expect(service.slotForBookingStatus('ALLOTMENT LETTER')).toBe('Pre-Agreement');
    expect(service.slotForBookingStatus('LOI')).toBe('Pre-Agreement');
    expect(service.slotForBookingStatus('FINAL POSSESSION')).toBe('Post-Agreement');
    expect(service.slotForBookingStatus('INTIMATION OF PROVISIONAL POSSESSION')).toBe('Post-Agreement');
  });

  it('returns null for a blank, placeholder or unlisted status', () => {
    expect(service.slotForBookingStatus('')).toBeNull();
    expect(service.slotForBookingStatus('   ')).toBeNull();
    expect(service.slotForBookingStatus('—')).toBeNull();
    expect(service.slotForBookingStatus('CANCELLED')).toBeNull();
    expect(service.slotForBookingStatus(null)).toBeNull();
  });

  it('boots on a config.json written before slots existed', async () => {
    await load(CONFIG);

    expect(service.bookingStatusSlots).toEqual({});
    expect(service.slotForBookingStatus('FILE BINDING DONE')).toBeNull();
    expect(service.usersInSlot('Post-Agreement')).toEqual([]);
  });

  it('picks up a re-staged status when config.json is loaded again', async () => {
    expect(service.slotForBookingStatus('DOCUMENT HANDOVER')).toBe('Post-Agreement');

    await load({
      ...SLOT_CONFIG,
      bookingStatusSlots: { 'Post-Possession': ['DOCUMENT HANDOVER'] },
    });

    expect(service.slotForBookingStatus('DOCUMENT HANDOVER')).toBe('Post-Possession');
  });
});
