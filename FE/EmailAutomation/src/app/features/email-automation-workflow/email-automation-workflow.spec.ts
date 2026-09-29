import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { EmailAutomationWorkflow } from './email-automation-workflow';
import { EmailDateDropdown } from './components/email-date-dropdown/email-date-dropdown';
import { EmailReceiptsTable } from './components/email-receipts-table/email-receipts-table';
import { EmailPaymentDetails } from './components/email-payment-details/email-payment-details';
import { ConfigService } from '../../core/services/config.service';

describe('EmailAutomationWorkflow', () => {
  let component: EmailAutomationWorkflow;
  let fixture: ComponentFixture<EmailAutomationWorkflow>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [EmailAutomationWorkflow, EmailDateDropdown, EmailReceiptsTable, EmailPaymentDetails],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ConfigService, useValue: { apiBaseUrl: 'http://test.local/api' } },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(EmailAutomationWorkflow);
    component = fixture.componentInstance;
    fixture.detectChanges();

    httpMock.expectOne('http://test.local/api/emailautomation/dates').flush([]);

    await fixture.whenStable();
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
