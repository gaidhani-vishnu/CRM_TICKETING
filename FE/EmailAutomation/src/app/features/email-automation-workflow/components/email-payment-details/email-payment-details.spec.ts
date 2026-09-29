import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { EmailPaymentDetails } from './email-payment-details';

describe('EmailPaymentDetails', () => {
  let component: EmailPaymentDetails;
  let fixture: ComponentFixture<EmailPaymentDetails>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [EmailPaymentDetails],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(EmailPaymentDetails);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
