import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

import { AuthService } from '../../../core/services/auth.service';
import { ConfigService } from '../../../core/services/config.service';
import {
  CustomerOption,
  HandoffStatusResponse,
  HandoffTokenResponse,
} from '../models/customer-payment-receipt.model';

/**
 * Talks to CustomerPaymentReceiptController
 * (BE/EmailAutomation/EmailAutomation/Controllers/CustomerPaymentReceiptController.cs).
 */
@Injectable({ providedIn: 'root' })
export class CustomerPaymentReceiptService {
  constructor(
    private readonly http: HttpClient,
    private readonly config: ConfigService,
    private readonly auth: AuthService
  ) {}

  private get baseUrl(): string {
    return `${this.config.apiBaseUrl}/customerpaymentreceipt`;
  }

  /** GET projects — every project with at least one live booking. */
  getProjects(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/projects`);
  }

  /** GET subprojects?project= */
  getSubProjects(project: string): Observable<string[]> {
    const params = new HttpParams().set('project', project);
    return this.http.get<string[]>(`${this.baseUrl}/subprojects`, { params });
  }

  /** GET units?project=&subProject= */
  getUnits(project: string, subProject: string): Observable<string[]> {
    const params = new HttpParams().set('project', project).set('subProject', subProject);
    return this.http.get<string[]>(`${this.baseUrl}/units`, { params });
  }

  /** GET customers?project=&subProject=&unit= — each name with the booking it stands for. */
  getCustomers(project: string, subProject: string, unit: string): Observable<CustomerOption[]> {
    const params = new HttpParams()
      .set('project', project)
      .set('subProject', subProject)
      .set('unit', unit);
    return this.http.get<CustomerOption[]>(`${this.baseUrl}/customers`, { params });
  }

  /** POST handoff-token — signs the hand-off for one booking. Needs the login token. */
  createHandoff(accountItemNo: string): Observable<HandoffTokenResponse> {
    return this.http.post<HandoffTokenResponse>(
      `${this.baseUrl}/handoff-token`,
      { accountItemNo },
      { headers: this.authHeaders() }
    );
  }

  /** GET handoff-status?id= — the backstop for the portal's postMessage. */
  getHandoffStatus(handoffId: string): Observable<HandoffStatusResponse> {
    const params = new HttpParams().set('id', handoffId);
    return this.http.get<HandoffStatusResponse>(`${this.baseUrl}/handoff-status`, {
      params,
      headers: this.authHeaders(),
    });
  }

  private authHeaders(): HttpHeaders {
    const token = this.auth.token;
    return token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : new HttpHeaders();
  }
}
