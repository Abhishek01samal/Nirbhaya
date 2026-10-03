import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';
import { getNearbyResponders as getNearbyRespondersService } from './responder.service.js';

/**
 * Thin controller: read nothing from the client (no query/body contract —
 * §10), delegate to the responder service, wrap in the standard envelope.
 * It never touches SOS or escalation state.
 */
export const getNearbyResponders = asyncHandler(async (req, res) => {
  console.log(`[responders] nearby responder request by user ${req.user.id}`);

  return sendSuccess(res, getNearbyRespondersService());
});
