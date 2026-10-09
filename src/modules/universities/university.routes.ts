import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './university.service.js';
import { courseBody, courseSearchQuery, universityBody, universityListQuery, updateCourseBody, updateUniversityBody } from './university.validation.js';

const m = createModuleRouter('/universities', 'Universities');

m.route({
  method: 'get',
  path: '/',
  summary: 'List universities (search by name, filter by country)',
  permissions: ['university.view'],
  query: universityListQuery,
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await service.listUniversities(ctx, query);
    return { data: items, pagination };
  },
});
m.route({ method: 'post', path: '/', summary: 'Add a university', permissions: ['university.manage'], body: universityBody, successStatus: 201, handler: async ({ ctx, body }) => ({ message: 'University added', data: await service.createUniversity(ctx, body) }) });
m.route({
  method: 'get',
  path: '/courses/search',
  summary: 'Course finder: filter by country, level, area, intake, budget and eligibility (optionally from a student profile)',
  permissions: ['university.view'],
  query: courseSearchQuery,
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination, appliedFilters } = await service.searchCourses(ctx, query);
    return { data: items, pagination, message: appliedFilters ? `Filtered for student: ${JSON.stringify(appliedFilters)}` : 'OK' };
  },
});
m.route({ method: 'patch', path: '/courses/:id', summary: 'Update a course', permissions: ['university.manage'], params: idParams, body: updateCourseBody, handler: async ({ ctx, params, body }) => ({ message: 'Course updated', data: await service.updateCourse(ctx, params.id, body) }) });
m.route({ method: 'get', path: '/:id', summary: 'University with its courses', permissions: ['university.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await service.getUniversity(ctx, params.id) }) });
m.route({ method: 'patch', path: '/:id', summary: 'Update a university (or deactivate it)', permissions: ['university.manage'], params: idParams, body: updateUniversityBody, handler: async ({ ctx, params, body }) => ({ message: 'University updated', data: await service.updateUniversity(ctx, params.id, body) }) });
m.route({ method: 'post', path: '/:id/courses', summary: 'Add a course (inherits the university’s requirements and fees)', permissions: ['university.manage'], params: idParams, body: courseBody, successStatus: 201, handler: async ({ ctx, params, body }) => ({ message: 'Course added', data: await service.createCourse(ctx, params.id, body) }) });

export const universityModule = m;
