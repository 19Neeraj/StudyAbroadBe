import { Router } from 'express';
import { auditModule } from '../modules/audit/audit.routes.js';
import { authModule } from '../modules/auth/auth.routes.js';
import { branchModule } from '../modules/branches/branch.routes.js';
import { dashboardModule } from '../modules/dashboard/dashboard.routes.js';
import { followUpModule } from '../modules/followups/followup.routes.js';
import { leadModule } from '../modules/leads/lead.routes.js';
import { organizationModule } from '../modules/organizations/organization.routes.js';
import { permissionModule } from '../modules/permissions/permission.routes.js';
import { roleModule } from '../modules/roles/role.routes.js';
import { settingsModule } from '../modules/settings/settings.routes.js';
import { studentModule } from '../modules/students/student.routes.js';
import { callModule } from '../modules/calls/call.routes.js';
import { fileModule } from '../modules/files/file.routes.js';
import { communicationModule } from '../modules/integrations/integration.routes.js';
import { webhookModule } from '../modules/webhooks/webhook.routes.js';
import { integrationHubModule } from '../modules/marketing/hub.routes.js';
import { marketingModule } from '../modules/marketing/marketing.routes.js';
import { eventModule } from '../modules/events/event.routes.js';
import { reportModule } from '../modules/reports/report.routes.js';
import { notificationModule } from '../modules/notifications/notification.routes.js';
import { deviceModule } from '../modules/devices/device.routes.js';
import { applicationModule, shortlistModule } from '../modules/applications/application.routes.js';
import { documentModule } from '../modules/documents/document.routes.js';
import { paymentModule } from '../modules/payments/payment.routes.js';
import { universityModule } from '../modules/universities/university.routes.js';
import { visaModule } from '../modules/visa/visa.routes.js';
import { userModule } from '../modules/users/user.routes.js';
import { securityModule, superAdminSecurityModule } from '../modules/security/security.routes.js';
import type { ModuleRouter } from '../utils/router.js';

/** Register new modules here; each owns its base path, routes and OpenAPI docs. */
const modules: ModuleRouter[] = [
  authModule,
  organizationModule,
  userModule,
  roleModule,
  permissionModule,
  branchModule,
  settingsModule,
  leadModule,
  followUpModule,
  dashboardModule,
  studentModule,
  universityModule,
  shortlistModule,
  applicationModule,
  paymentModule,
  visaModule,
  documentModule,
  callModule,
  communicationModule,
  webhookModule,
  integrationHubModule,
  marketingModule,
  eventModule,
  reportModule,
  notificationModule,
  fileModule,
  deviceModule,
  auditModule,
  securityModule,
  superAdminSecurityModule,
];

export const apiRouter = Router();
for (const m of modules) apiRouter.use(m.basePath, m.router);
