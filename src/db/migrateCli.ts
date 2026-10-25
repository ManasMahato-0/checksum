// `npm run migrate` (or `node dist/db/migrateCli.js`): apply pending migrations and exit.
import { Pool } from 'pg';
import { pgDb } from './db';
import { migrate } from './migrate';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: DATABASE_URL });
migrate(pgDb(pool))
  .then((ran) => console.log(ran.length ? `applied: ${ran.join(', ')}` : 'database is up to date'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
