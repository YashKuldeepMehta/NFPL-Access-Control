import { Router } from 'express';
import me from './me.js';
import jobs from './jobs.js';
import access from './access.js';
import explain from './explain.js';

const r = Router();
r.use(me);
r.use(jobs);
r.use(access);
r.use(explain);
export default r;
