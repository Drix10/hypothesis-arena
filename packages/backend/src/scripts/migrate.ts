import fs from 'fs';
import path from 'path';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

async function migrate() {
    const migrationsDir = path.join(__dirname, '../../migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    logger.info(`Found ${files.length} migration files`);

    for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        logger.info(`Running migration: ${file}`);

        try {
            await pool.query(sql);
            logger.info(`Migration ${file} completed`);
        } catch (error: any) {
            // Ignore "already exists" errors
            if (error.code === '42P07' || error.code === '42710') {
                logger.info(`Migration ${file} - objects already exist, skipping`);
            } else {
                logger.error(`Migration ${file} failed:`, error);
                throw error;
            }
        }
    }

    logger.info('All migrations completed');
    await pool.end();
}

migrate().catch((error) => {
    logger.error('Migration failed:', error);
    process.exit(1);
});
