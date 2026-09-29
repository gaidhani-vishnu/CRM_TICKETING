import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { DashboardSummary, emptyDashboardSummary } from '../../../features/user-dashboard/models/user-dashboard.model';

@Component({
  selector: 'app-kpi-status-ribbon',
  standalone: false,
  templateUrl: './kpi-status-ribbon.html',
  styleUrl: './kpi-status-ribbon.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KpiStatusRibbon {
  @Input() summary: DashboardSummary = emptyDashboardSummary();
  @Input() collapsible = true;

  @Output() collapsedChanged = new EventEmitter<boolean>();

  isCollapsed = false;

  toggleCollapse(): void {
    if (!this.collapsible) return;
    this.isCollapsed = !this.isCollapsed;
    this.collapsedChanged.emit(this.isCollapsed);
  }

  get isSlaHealthy(): boolean {
    return (this.summary?.slaPercent ?? 0) >= 90;
  }
}
