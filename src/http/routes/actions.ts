import { Router } from 'express';
import { executeAction } from '../../actions/execute.js';
import { actionManifest } from '../../actions/registry.js';
import { kravAktor } from '../middleware/autentisera.js';

/**
 * Transportlagret är BARA transport: ingen affärslogik, ingen SQL. Den enda
 * beslutspunkten här är att aktören hämtas ur den autentiserade nyckeln och
 * aldrig ur request-body.
 */
export const actionsRouter = Router();

actionsRouter.get('/actions', (req, res) => {
  kravAktor(req);
  res.json({ actions: actionManifest() });
});

actionsRouter.post('/actions/:name', async (req, res) => {
  const utfall = await executeAction({
    aktor: kravAktor(req),
    actionName: req.params.name ?? '',
    input: req.body ?? {},
  });
  res.json(utfall);
});
