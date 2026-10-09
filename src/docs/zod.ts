import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Must run before any schema calls `.openapi()`. All schema files import `z` from here.
extendZodWithOpenApi(z);

export { z };
