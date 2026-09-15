import { Router, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TELEMT_VERSION } from '../config';

const router = Router();

let nodeVersion = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
  nodeVersion = pkg.version || 'unknown';
} catch {}

router.get('/', (_req: Request, res: Response) => {
  // telemtVersion is what new and recreated proxy containers get; running ones may lag.
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: nodeVersion, telemtVersion: TELEMT_VERSION });
});

export default router;
