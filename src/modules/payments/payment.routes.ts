import { z } from '../../docs/zod.js';
import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { createPayment, createPaymentBody, getPayment, listPayments, paymentListQuery, updatePayment, updatePaymentBody } from './payment.service.js';

const m = createModuleRouter('/payments', 'Payments');
m.route({
  method: 'get',
  path: '/',
  summary: 'List payments',
  permissions: ['payment.view'],
  query: paymentListQuery,
  paginated: true,
  handler: async ({ ctx, query }) => {
    const { items, pagination } = await listPayments(ctx, query);
    return { data: items, pagination };
  },
});
m.route({ method: 'get', path: '/summary', summary: 'Totals by status and currency for the same filters', permissions: ['payment.view'], query: paymentListQuery, response: z.array(z.object({ status: z.string(), currency: z.string(), amount: z.number() })), handler: async ({ ctx, query }) => ({ data: (await listPayments(ctx, { ...query, limit: 1 })).totals }) });
m.route({ method: 'post', path: '/', summary: 'Record a payment (tuition payments move the lead to Payment Pending)', permissions: ['payment.manage'], body: createPaymentBody, successStatus: 201, handler: async ({ ctx, body }) => ({ message: 'Payment recorded', data: await createPayment(ctx, body) }) });
m.route({ method: 'get', path: '/:id', summary: 'Payment details', permissions: ['payment.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await getPayment(ctx, params.id) }) });
m.route({ method: 'patch', path: '/:id', summary: 'Update a payment (status, transaction id, dates); every change is audited', permissions: ['payment.manage'], params: idParams, body: updatePaymentBody, handler: async ({ ctx, params, body }) => ({ message: 'Payment updated', data: await updatePayment(ctx, params.id, body) }) });

export const paymentModule = m;
