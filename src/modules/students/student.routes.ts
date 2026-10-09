import { z } from '../../docs/zod.js';
import { activityDto, activityListQuery } from '../activities/activity.validation.js';
import { listLeadActivities } from '../activities/activity.service.js';
import { describeCatalog, filterFieldDto } from '../../utils/filterTree.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { STUDENT_FILTER_FIELDS } from './student.filters.js';
import * as service from './student.service.js';
import { studentDto, studentListQuery, updateStudentBody } from './student.validation.js';

const m = createModuleRouter('/students', 'Students');

m.route({
  method: 'get',
  path: '/',
  summary: 'List students with search, filters (incl. nested AND/OR) and pagination',
  description: 'Search matches #number, phone, email prefix and name-word prefixes. Results follow the caller’s data scope.',
  permissions: ['student.view'],
  query: studentListQuery,
  response: z.array(studentDto),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listStudents(ctx, query);
    return { data: items, pagination };
  },
});

m.route({
  method: 'get',
  path: '/filter-fields',
  summary: 'Fields and operators available to the advanced student filter',
  permissions: ['student.view'],
  response: z.array(filterFieldDto),
  handler: async () => ({ data: describeCatalog(STUDENT_FILTER_FIELDS) }),
});

m.route({
  method: 'get',
  path: '/:id',
  summary: 'Student profile (all sections, plus the linked lead’s stage and source)',
  permissions: ['student.view'],
  params: idParams,
  response: studentDto,
  handler: async ({ ctx, params }) => ({ data: await service.getStudent(ctx, params.id) }),
});

m.route({
  method: 'patch',
  path: '/:id',
  summary: 'Update student profile sections',
  description: 'Send only the sections you change. `education`, `testScores` and `workExperience` replace the whole list. Passport changes are audited without the number.',
  permissions: ['student.update'],
  params: idParams,
  body: updateStudentBody,
  response: studentDto,
  handler: async ({ ctx, params, body }) => ({ message: 'Student updated', data: await service.updateStudent(ctx, params.id, body) }),
});

m.route({
  method: 'get',
  path: '/:id/activities',
  summary: 'Student timeline (shared with the lead it was converted from)',
  permissions: ['student.view'],
  params: idParams,
  query: activityListQuery,
  response: z.array(activityDto),
  paginated: true,
  handler: async ({ ctx, params, query }) => {
    const student = await service.loadStudent(ctx, params.id);
    const { items, pagination } = await listLeadActivities(ctx, student.leadId, query);
    return { data: items, pagination };
  },
});

export const studentModule = m;
