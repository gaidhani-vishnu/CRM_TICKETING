import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { EmailDateDropdown } from './email-date-dropdown';
import { ConfigService } from '../../../../core/services/config.service';

describe('EmailDateDropdown', () => {
  let component: EmailDateDropdown;
  let fixture: ComponentFixture<EmailDateDropdown>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [EmailDateDropdown],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // Real ConfigService is populated by an APP_INITIALIZER at bootstrap,
        // which doesn't run in tests — stub it so apiBaseUrl is available.
        { provide: ConfigService, useValue: { apiBaseUrl: 'http://test.local/api' } },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(EmailDateDropdown);
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
