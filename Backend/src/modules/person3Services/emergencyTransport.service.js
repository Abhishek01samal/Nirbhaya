import { buildQueries, searchTransport } from "./tavilyTransport.service.js";

async function searchEmergencyTransport({ sourceName, destinationName }) {
  const queries = buildQueries(sourceName, destinationName);

  const [flights, trains, cabs] = await Promise.allSettled([
    searchTransport(queries.flights, "flights"),
    searchTransport(queries.trains, "trains"),
    searchTransport(queries.cabs, "cabs"),
  ]);

  const category = (result) =>
    result.status === "fulfilled"
      ? { results: result.value }
      : { results: [], error: { code: result.reason?.code || "TAVILY_API_ERROR", message: result.reason?.message || "Transport search failed" } };

  return {
    queries,
    flights: category(flights),
    trains: category(trains),
    cabs: category(cabs),
  };
}

export { searchEmergencyTransport };
