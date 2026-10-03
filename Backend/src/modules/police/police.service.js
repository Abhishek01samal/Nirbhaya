import { ApiError } from '../../utils/ApiError.js';
import { PROTOTYPE_POLICE_STATION } from './police.data.js';
import { POLICE_SOURCE } from './police.constants.js';

/**
 * Prototype police service — the ONE entry point to the hardcoded station.
 *
 *   escalation service -> this service -> police.data.js
 *
 * The POST /api/v1/sos/:id/escalation/police flow must call this same service
 * instead of re-declaring the station, so the data has a single source of
 * truth and the controller never sees raw configuration.
 *
 * Intentionally simple (§4/§15): no coordinates in, no station search out, no
 * ranking, no database, no external API. Replacing the prototype with a real
 * integration later means swapping this resolver — the escalation service,
 * controller and response contract stay untouched.
 */
export const getPrototypePoliceStation = () => {
  const station = PROTOTYPE_POLICE_STATION;

  if (!station?.id || !station?.name || !station?.phone) {
    throw ApiError.internal(
      'POLICE_STATION_UNAVAILABLE',
      'Prototype police station is unavailable'
    );
  }

  return {
    source: POLICE_SOURCE.PROTOTYPE_HARDCODED,
    station,
  };
};
