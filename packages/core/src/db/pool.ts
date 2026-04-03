import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  min?: number;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export function getPool(config?: DbConfig): pg.Pool {
  if (pool) return pool;

  const connectionString = config?.connectionString || process.env.DATABASE_URL;
  const useSSL = process.env.DATABASE_SSL === 'true';

  pool = new Pool({
    connectionString,
    host: config?.host,
    port: config?.port,
    database: config?.database,
    user: config?.user,
    password: config?.password,
    min: config?.min ?? parseInt(process.env.DATABASE_POOL_MIN || '2', 10),
    max: config?.max ?? parseInt(process.env.DATABASE_POOL_MAX || '20', 10),
    idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 5000,
    ...(useSSL && { ssl: { rejectUnauthorized: true } }),
  });

  pool.on('error', (err) => {
    console.error('[nexus] Unexpected database pool error:', err.message);
  });

  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params);
}

export async function getClient(): Promise<pg.PoolClient> {
  const p = getPool();
  return p.connect();
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const result = await query('SELECT 1 as ok');
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
