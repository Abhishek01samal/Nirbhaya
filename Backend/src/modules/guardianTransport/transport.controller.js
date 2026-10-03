import { resolveLocations, LocationResolveError } from "../person3Services/geminiLocationResolver.service.js";
import { searchEmergencyTransport } from "../person3Services/emergencyTransport.service.js";

function validateCoordinates(value) {
  if (!value || typeof value !== "object") return "must be an object";
  const { lat, lng } = value;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return "lat must be a number between -90 and 90";
  }
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return "lng must be a number between -180 and 180";
  }
  return null;
}

async function searchTransport(req, res) {
  const { victimLocation, guardianLocation } = req.body ?? {};

  if (victimLocation === undefined || guardianLocation === undefined) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "victimLocation and guardianLocation are required" },
    });
  }

  const victimError = validateCoordinates(victimLocation);
  if (victimError) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: `victimLocation: ${victimError}` },
    });
  }

  const guardianError = validateCoordinates(guardianLocation);
  if (guardianError) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: `guardianLocation: ${guardianError}` },
    });
  }

  try {
    const locations = await resolveLocations({ guardianLocation, victimLocation });

    const sourceName = locations.source.name || locations.source.city;
    const destinationName = locations.destination.name || locations.destination.city;

    const transport = await searchEmergencyTransport({ sourceName, destinationName });

    const withCoords = (loc, coords) => ({ coordinates: { lat: coords.lat, lng: coords.lng }, ...loc });

    return res.status(200).json({
      success: true,
      data: {
        source: withCoords(locations.source, guardianLocation),
        destination: withCoords(locations.destination, victimLocation),
        transport: {
          flights: transport.flights.results,
          trains: transport.trains.results,
          cabs: transport.cabs.results,
        },
        transportErrors: {
          flights: transport.flights.error || null,
          trains: transport.trains.error || null,
          cabs: transport.cabs.error || null,
        },
      },
    });
  } catch (err) {
    if (err instanceof LocationResolveError) {
      return res.status(err.status).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    console.error("emergency transport search error:", err);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  }
}

export { searchTransport, validateCoordinates };
