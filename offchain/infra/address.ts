import { z } from 'zod';

export const EvmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
