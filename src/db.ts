import { Pool } from 'pg';

export const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '15436', 10),
  user: process.env.PGUSER || 'urbanglider',
  password: process.env.PGPASSWORD || 'glidepassword',
  database: process.env.PGDATABASE || 'urbanglide_db',
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}
