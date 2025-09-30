import { Pool } from 'pg';
import type { QueryResult, QueryConfig } from 'pg';
import { instrument } from './instrument';

const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = {
  query: <T extends unknown[]>(
    queryTextOrConfig: string | any,
    values?: T,
  ): Promise<any> => {
    const queryName = typeof queryTextOrConfig === 'string' ? queryTextOrConfig.split(' ')[0].toLowerCase() : queryTextOrConfig.name || 'unknown';
    return instrument('db', queryName, () => dbPool.query(queryTextOrConfig, values));
  },
  end: () => dbPool.end(),
};