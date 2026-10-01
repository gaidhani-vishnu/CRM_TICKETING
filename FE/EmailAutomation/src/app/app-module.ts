import {
  NgModule,
  provideBrowserGlobalErrorListeners,
  provideAppInitializer,
  inject,
} from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing-module';
import { App } from './app';
import { EmailAutomationWorkflow } from './features/email-automation-workflow/email-automation-workflow';
import { ConfigService } from './core/services/config.service';
import { UserDirectoryService } from './core/services/user-directory.service';
import { EmailDateDropdown } from './features/email-automation-workflow/components/email-date-dropdown/email-date-dropdown';
import { EmailReceiptsTable } from './features/email-automation-workflow/components/email-receipts-table/email-receipts-table';
import { EmailPaymentDetails } from './features/email-automation-workflow/components/email-payment-details/email-payment-details';
import { WorkflowVisualizer } from './features/email-automation-workflow/components/workflow-visualizer/workflow-visualizer';
import { StepInspector } from './features/email-automation-workflow/components/step-inspector/step-inspector';
import { WorkflowEditDialog } from './features/email-automation-workflow/components/workflow-edit-dialog/workflow-edit-dialog';
import { ThreadAttachments } from './features/email-automation-workflow/components/thread-attachments/thread-attachments';
import { ReceiptsSummary } from './features/email-automation-workflow/components/receipts-summary/receipts-summary';
import { AlertPopup } from './features/email-automation-workflow/components/alert-popup/alert-popup';
import { EmailRecipientInput } from './features/email-automation-workflow/components/email-recipient-input/email-recipient-input';
import { CrmWorkspaceShell } from './features/crm-workspace-shell/crm-workspace-shell';
import { UserDashboard } from './features/user-dashboard/user-dashboard';
import { WorkflowMatrix } from './features/user-dashboard/components/workflow-matrix/workflow-matrix';
import { TicketDrilldown } from './features/user-dashboard/components/ticket-drilldown/ticket-drilldown';
import { TicketDrawer } from './features/user-dashboard/components/ticket-drawer/ticket-drawer';
import { KpiStatusRibbon } from './shared/components/kpi-status-ribbon/kpi-status-ribbon';
import { UserFilter } from './shared/components/user-filter/user-filter';
import { SideNav } from './shared/components/side-nav/side-nav';
import { Login } from './features/login/login';
import { NewDashboard } from './features/new-dashboard/new-dashboard';
import { UserAccountMenu } from './shared/components/user-account-menu/user-account-menu';
import { ProfileModal } from './shared/components/profile-modal/profile-modal';
import { ToastHost } from './shared/components/toast-host/toast-host';
import { CustomerPaymentReceipt } from './features/customer-payment-receipt/customer-payment-receipt';

@NgModule({
  declarations: [
    App,
    Login,
    NewDashboard,
    UserAccountMenu,
    ProfileModal,
    CrmWorkspaceShell,
    EmailAutomationWorkflow,
    EmailDateDropdown,
    EmailReceiptsTable,
    EmailPaymentDetails,
    WorkflowVisualizer,
    StepInspector,
    WorkflowEditDialog,
    ThreadAttachments,
    ReceiptsSummary,
    AlertPopup,
    EmailRecipientInput,
    UserDashboard,
    WorkflowMatrix,
    TicketDrilldown,
    TicketDrawer,
    KpiStatusRibbon,
    UserFilter,
    SideNav,
    ToastHost,
    CustomerPaymentReceipt,
  ],
  // FormsModule is here for the edit dialog's [(ngModel)] inputs — the first
  // place in the app that takes typed input rather than only rendering data.
  imports: [BrowserModule, AppRoutingModule, FormsModule],
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    // Loads public/config.json before the app renders, so ConfigService
    // is guaranteed populated everywhere the app is used — then the user
    // master list, whose URL comes from that config. The list never fails
    // startup (see UserDirectoryService.load).
    provideAppInitializer(async () => {
      const config = inject(ConfigService);
      const directory = inject(UserDirectoryService);

      await config.loadConfig();
      await directory.load();
    }),
  ],
  bootstrap: [App],
})
export class AppModule {}
