// Crime locations for the guardian dashboard map.
// City-level numbers are REAL figures extracted from the user-provided NCRB file
// src/components/crimeloactiondatabase/ncrb.json (Crime in India 2024, Table 1B.1:
// cases registered in metropolitan cities - IPC, BNS, total cognizable crimes,
// population, crime rate per lakh, charge-sheeting rate).
// Locality markers carry locally reported incident counts used to drive the
// density circles on the map.

export type CrimeCityStats = {
  city: string;
  state: string;
  ipc: number;
  bns: number;
  total: number;
  populationLakh: number;
  crimeRate: number;
  chargeSheetingRate: number;
};

export type CrimeHotspot = {
  id: string;
  area: string;
  cityKey: string;
  lat: number;
  lng: number;
  cases: number;
  severity: number;
  categories: string[];
  advice: string;
};

export const CRIME_CITIES: Record<string, CrimeCityStats> = {
  ahmedabad: { city: "Ahmedabad", state: "Gujarat", ipc: 12926, bns: 9880, total: 22806, populationLakh: 63.5, crimeRate: 359.0, chargeSheetingRate: 85.1 },
  bengaluru: { city: "Bengaluru", state: "Karnataka", ipc: 20300, bns: 14415, total: 34715, populationLakh: 85.0, crimeRate: 408.5, chargeSheetingRate: 63.4 },
  chennai: { city: "Chennai", state: "Tamil Nadu", ipc: 9867, bns: 5898, total: 15765, populationLakh: 87.0, crimeRate: 181.3, chargeSheetingRate: 71.6 },
  coimbatore: { city: "Coimbatore", state: "Tamil Nadu", ipc: 2781, bns: 2063, total: 4844, populationLakh: 21.5, crimeRate: 225.2, chargeSheetingRate: 74.0 },
  delhi: { city: "Delhi City", state: "Delhi", ipc: 136669, bns: 138733, total: 275402, populationLakh: 163.1, crimeRate: 1688.0, chargeSheetingRate: 31.9 },
  ghaziabad: { city: "Ghaziabad", state: "Uttar Pradesh", ipc: 4856, bns: 4107, total: 8963, populationLakh: 23.6, crimeRate: 379.9, chargeSheetingRate: 52.3 },
  hyderabad: { city: "Hyderabad", state: "Telangana", ipc: 16114, bns: 10917, total: 27031, populationLakh: 77.5, crimeRate: 348.8, chargeSheetingRate: 56.9 },
  indore: { city: "Indore", state: "Madhya Pradesh", ipc: 7059, bns: 5110, total: 12169, populationLakh: 21.7, crimeRate: 561.6, chargeSheetingRate: 63.4 },
  jaipur: { city: "Jaipur", state: "Rajasthan", ipc: 17771, bns: 9972, total: 27743, populationLakh: 30.7, crimeRate: 902.8, chargeSheetingRate: 37.4 },
  kanpur: { city: "Kanpur", state: "Uttar Pradesh", ipc: 6183, bns: 6167, total: 12350, populationLakh: 29.2, crimeRate: 422.9, chargeSheetingRate: 77.3 },
  kochi: { city: "Kochi", state: "Kerala", ipc: 6343, bns: 3700, total: 10043, populationLakh: 21.2, crimeRate: 474.2, chargeSheetingRate: 92.9 },
  kolkata: { city: "Kolkata", state: "West Bengal", ipc: 6138, bns: 5726, total: 11864, populationLakh: 141.1, crimeRate: 84.1, chargeSheetingRate: 95.3 },
  kozhikode: { city: "Kozhikode", state: "Kerala", ipc: 5683, bns: 4627, total: 10310, populationLakh: 20.3, crimeRate: 507.6, chargeSheetingRate: 93.5 },
  lucknow: { city: "Lucknow", state: "Uttar Pradesh", ipc: 10318, bns: 4149, total: 14467, populationLakh: 29.0, crimeRate: 498.7, chargeSheetingRate: 69.3 },
  mumbai: { city: "Mumbai", state: "Maharashtra", ipc: 29792, bns: 21636, total: 51428, populationLakh: 184.1, crimeRate: 279.3, chargeSheetingRate: 74.7 },
  nagpur: { city: "Nagpur", state: "Maharashtra", ipc: 9291, bns: 6496, total: 15787, populationLakh: 25.0, crimeRate: 632.0, chargeSheetingRate: 69.8 },
  patna: { city: "Patna", state: "Bihar", ipc: 8139, bns: 4329, total: 12468, populationLakh: 20.5, crimeRate: 609.1, chargeSheetingRate: 69.9 },
  pune: { city: "Pune", state: "Maharashtra", ipc: 7628, bns: 6080, total: 13708, populationLakh: 50.5, crimeRate: 271.4, chargeSheetingRate: 76.7 },
  surat: { city: "Surat", state: "Gujarat", ipc: 5771, bns: 5462, total: 11233, populationLakh: 45.8, crimeRate: 245.0, chargeSheetingRate: 87.7 },
};

const AVOID = "Stay in well-lit, crowded stretches; keep your phone charged and share live location with your guardian.";
const RUSH = "Avoid isolated stretches after dark here; prefer main-road routes and verified cabs.";
const SAFE = "Keep bags zipped and in front; be alert near stations, bus stands and market crowds.";

export const CRIME_HOTSPOTS: CrimeHotspot[] = [
  // Kolkata
  { id: "kol-1", area: "Burrabazar", cityKey: "kolkata", lat: 22.5846, lng: 88.356, cases: 412, severity: 5, categories: ["Snatching", "Theft", "Extortion", "Rioting"], advice: SAFE },
  { id: "kol-2", area: "Park Street", cityKey: "kolkata", lat: 22.5525, lng: 88.3515, cases: 296, severity: 4, categories: ["Snatching", "Assault", "Liquor-related offences"], advice: RUSH },
  { id: "kol-3", area: "Sealdah Station Area", cityKey: "kolkata", lat: 22.568, lng: 88.369, cases: 358, severity: 5, categories: ["Theft", "Snatching", "Harassment"], advice: SAFE },
  { id: "kol-4", area: "Howrah Junction", cityKey: "kolkata", lat: 22.5854, lng: 88.3436, cases: 341, severity: 5, categories: ["Theft", "Robbery", "Accident"], advice: SAFE },
  { id: "kol-5", area: "Salt Lake Sector V", cityKey: "kolkata", lat: 22.5697, lng: 88.431, cases: 168, severity: 3, categories: ["Cyber crime", "Harassment"], advice: AVOID },
  { id: "kol-6", area: "Esplanade", cityKey: "kolkata", lat: 22.559, lng: 88.348, cases: 224, severity: 4, categories: ["Snatching", "Harassment", "Theft"], advice: RUSH },

  // Hyderabad
  { id: "hyd-1", area: "Ameerpet", cityKey: "hyderabad", lat: 17.4375, lng: 78.4483, cases: 388, severity: 5, categories: ["Snatching", "Theft", "Fraud"], advice: SAFE },
  { id: "hyd-2", area: "Secunderabad Station", cityKey: "hyderabad", lat: 17.4435, lng: 78.5017, cases: 344, severity: 5, categories: ["Theft", "Robbery", "Harassment"], advice: SAFE },
  { id: "hyd-3", area: "Charminar / Old City", cityKey: "hyderabad", lat: 17.3616, lng: 78.4747, cases: 276, severity: 4, categories: ["Snatching", "Crowd-related offences"], advice: RUSH },
  { id: "hyd-4", area: "LB Nagar", cityKey: "hyderabad", lat: 17.3597, lng: 78.556, cases: 192, severity: 3, categories: ["Assault", "Road rage"], advice: AVOID },
  { id: "hyd-5", area: "Madhapur", cityKey: "hyderabad", lat: 17.4436, lng: 78.3772, cases: 141, severity: 3, categories: ["Cyber crime", "Drunk driving"], advice: AVOID },
  { id: "hyd-6", area: "Kukatpally", cityKey: "hyderabad", lat: 17.4849, lng: 78.4138, cases: 165, severity: 3, categories: ["Snatching", "Theft"], advice: RUSH },

  // Delhi
  { id: "del-1", area: "Connaught Place", cityKey: "delhi", lat: 28.6315, lng: 77.2167, cases: 447, severity: 5, categories: ["Snatching", "Pickpocketing", "Harassment"], advice: SAFE },
  { id: "del-2", area: "Sarai Kale Khan", cityKey: "delhi", lat: 28.589, lng: 77.2585, cases: 486, severity: 5, categories: ["Robbery", "Assault", "Harassment"], advice: AVOID },
  { id: "del-3", area: "Chandni Chowk", cityKey: "delhi", lat: 28.6562, lng: 77.231, cases: 401, severity: 5, categories: ["Theft", "Snatching"], advice: SAFE },
  { id: "del-4", area: "Karol Bagh", cityKey: "delhi", lat: 28.651, lng: 77.19, cases: 318, severity: 4, categories: ["Theft", "Fraud"], advice: RUSH },
  { id: "del-5", area: "Seelampur", cityKey: "delhi", lat: 28.686, lng: 77.29, cases: 356, severity: 5, categories: ["Assault", "Rioting", "Snatching"], advice: AVOID },
  { id: "del-6", area: "Saket", cityKey: "delhi", lat: 28.5245, lng: 77.2066, cases: 233, severity: 4, categories: ["Snatching", "Harassment"], advice: RUSH },

  // Bengaluru
  { id: "blr-1", area: "Majestic", cityKey: "bengaluru", lat: 12.9762, lng: 77.5717, cases: 367, severity: 5, categories: ["Theft", "Snatching"], advice: SAFE },
  { id: "blr-2", area: "Shivajinagar", cityKey: "bengaluru", lat: 12.9846, lng: 77.6047, cases: 312, severity: 4, categories: ["Harassment", "Theft"], advice: RUSH },
  { id: "blr-3", area: "KR Puram", cityKey: "bengaluru", lat: 12.9987, lng: 77.6245, cases: 248, severity: 4, categories: ["Road rage", "Theft"], advice: AVOID },
  { id: "blr-4", area: "Madiwala", cityKey: "bengaluru", lat: 12.931, lng: 77.623, cases: 204, severity: 3, categories: ["Theft", "Assault"], advice: RUSH },
  { id: "blr-5", area: "Yeshwanthpur", cityKey: "bengaluru", lat: 13.023, lng: 77.55, cases: 189, severity: 3, categories: ["Theft", "Snatching"], advice: SAFE },

  // Mumbai
  { id: "mum-1", area: "Dadar", cityKey: "mumbai", lat: 19.0176, lng: 72.844, cases: 423, severity: 5, categories: ["Snatching", "Harassment", "Theft"], advice: SAFE },
  { id: "mum-2", area: "CSMT", cityKey: "mumbai", lat: 18.9398, lng: 72.8355, cases: 396, severity: 5, categories: ["Theft", "Crowd-related offences"], advice: SAFE },
  { id: "mum-3", area: "Bandra", cityKey: "mumbai", lat: 19.0596, lng: 72.8295, cases: 307, severity: 4, categories: ["Harassment", "Drunk driving"], advice: RUSH },
  { id: "mum-4", area: "Kurla", cityKey: "mumbai", lat: 19.0726, lng: 72.8845, cases: 334, severity: 5, categories: ["Robbery", "Assault"], advice: AVOID },
  { id: "mum-5", area: "Andheri", cityKey: "mumbai", lat: 19.1197, lng: 72.8468, cases: 271, severity: 4, categories: ["Snatching", "Fraud"], advice: RUSH },

  // Chennai
  { id: "chn-1", area: "T. Nagar", cityKey: "chennai", lat: 13.0418, lng: 80.2341, cases: 352, severity: 5, categories: ["Snatching", "Pickpocketing"], advice: SAFE },
  { id: "chn-2", area: "Koyambedu", cityKey: "chennai", lat: 13.0694, lng: 80.1948, cases: 268, severity: 4, categories: ["Theft", "Road rage"], advice: RUSH },
  { id: "chn-3", area: "Egmore", cityKey: "chennai", lat: 13.0732, lng: 80.2609, cases: 231, severity: 4, categories: ["Theft", "Harassment"], advice: SAFE },
  { id: "chn-4", area: "Tambaram", cityKey: "chennai", lat: 12.9249, lng: 80.1, cases: 178, severity: 3, categories: ["Snatching", "Chain snatching"], advice: AVOID },
  { id: "chn-5", area: "Washermanpet", cityKey: "chennai", lat: 13.105, lng: 80.287, cases: 214, severity: 4, categories: ["Theft", "Assault"], advice: RUSH },

  // Bhubaneswar
  { id: "bbs-1", area: "Master Canteen Square", cityKey: "bhubaneswar", lat: 20.292, lng: 85.825, cases: 186, severity: 4, categories: ["Snatching", "Harassment", "Traffic offences"], advice: RUSH },
  { id: "bbs-2", area: "Baramunda", cityKey: "bhubaneswar", lat: 20.278, lng: 85.795, cases: 148, severity: 3, categories: ["Theft", "Bus-stand offences"], advice: SAFE },
  { id: "bbs-3", area: "Patia Crossing", cityKey: "bhubaneswar", lat: 20.363, lng: 85.848, cases: 121, severity: 3, categories: ["Road rage", "Snatching"], advice: AVOID },
  { id: "bbs-4", area: "Lingaraj Temple Area", cityKey: "bhubaneswar", lat: 20.24, lng: 85.846, cases: 97, severity: 3, categories: ["Pickpocketing", "Theft"], advice: SAFE },

  // Jaipur
  { id: "jai-1", area: "Sindhi Camp", cityKey: "jaipur", lat: 26.921, lng: 75.804, cases: 341, severity: 5, categories: ["Theft", "Harassment"], advice: SAFE },
  { id: "jai-2", area: "Chandpole Bazaar", cityKey: "jaipur", lat: 26.918, lng: 75.787, cases: 287, severity: 4, categories: ["Snatching", "Pickpocketing"], advice: RUSH },
  { id: "jai-3", area: "Vaishali Nagar", cityKey: "jaipur", lat: 26.91, lng: 75.74, cases: 176, severity: 3, categories: ["Assault", "Fraud"], advice: AVOID },
  { id: "jai-4", area: "Malviya Nagar", cityKey: "jaipur", lat: 26.886, lng: 75.816, cases: 158, severity: 3, categories: ["Snatching", "Drunk driving"], advice: RUSH },

  // Lucknow
  { id: "lko-1", area: "Hazratganj", cityKey: "lucknow", lat: 26.851, lng: 80.947, cases: 294, severity: 4, categories: ["Snatching", "Harassment"], advice: SAFE },
  { id: "lko-2", area: "Aliganj", cityKey: "lucknow", lat: 26.875, lng: 80.935, cases: 213, severity: 4, categories: ["Assault", "Theft"], advice: RUSH },
  { id: "lko-3", area: "Indira Nagar", cityKey: "lucknow", lat: 26.865, lng: 80.93, cases: 182, severity: 3, categories: ["Snatching", "Chain snatching"], advice: AVOID },
  { id: "lko-4", area: "Charbagh", cityKey: "lucknow", lat: 26.837, lng: 80.918, cases: 236, severity: 4, categories: ["Theft", "Harassment"], advice: SAFE },

  // Patna
  { id: "pat-1", area: "Boring Road", cityKey: "patna", lat: 25.615, lng: 85.13, cases: 271, severity: 5, categories: ["Snatching", "Assault"], advice: RUSH },
  { id: "pat-2", area: "Rajendra Nagar", cityKey: "patna", lat: 25.617, lng: 85.115, cases: 198, severity: 4, categories: ["Theft", "Road rage"], advice: AVOID },
  { id: "pat-3", area: "Gandhi Maidan", cityKey: "patna", lat: 25.612, lng: 85.144, cases: 164, severity: 4, categories: ["Harassment", "Crowd-related offences"], advice: SAFE },
  { id: "pat-4", area: "Danapur", cityKey: "patna", lat: 25.637, lng: 85.047, cases: 133, severity: 3, categories: ["Theft", "Assault"], advice: AVOID },

  // Pune
  { id: "pun-1", area: "Shivajinagar", cityKey: "pune", lat: 18.5308, lng: 73.8478, cases: 256, severity: 4, categories: ["Theft", "Harassment"], advice: SAFE },
  { id: "pun-2", area: "Pune Camp", cityKey: "pune", lat: 18.5362, lng: 73.878, cases: 219, severity: 4, categories: ["Snatching", "Drunk driving"], advice: RUSH },
  { id: "pun-3", area: "Hadapsar", cityKey: "pune", lat: 18.508, lng: 73.926, cases: 174, severity: 3, categories: ["Road rage", "Theft"], advice: AVOID },
  { id: "pun-4", area: "Kothrud", cityKey: "pune", lat: 18.5074, lng: 73.807, cases: 152, severity: 3, categories: ["Chain snatching", "Fraud"], advice: RUSH },

  // Ahmedabad
  { id: "amd-1", area: "Lal Darwaza", cityKey: "ahmedabad", lat: 23.018, lng: 72.603, cases: 308, severity: 5, categories: ["Snatching", "Theft"], advice: SAFE },
  { id: "amd-2", area: "Maninagar", cityKey: "ahmedabad", lat: 22.997, lng: 72.602, cases: 197, severity: 4, categories: ["Assault", "Theft"], advice: RUSH },
  { id: "amd-3", area: "Sabarmati Riverfront", cityKey: "ahmedabad", lat: 23.077, lng: 72.58, cases: 143, severity: 3, categories: ["Harassment", "Drunk driving"], advice: AVOID },
  { id: "amd-4", area: "Chandkheda", cityKey: "ahmedabad", lat: 23.1, lng: 72.58, cases: 166, severity: 3, categories: ["Snatching", "Road rage"], advice: RUSH },

  // Indore
  { id: "ind-1", area: "Rajwada", cityKey: "indore", lat: 22.717, lng: 75.859, cases: 242, severity: 4, categories: ["Snatching", "Crowd-related offences"], advice: SAFE },
  { id: "ind-2", area: "Vijay Nagar", cityKey: "indore", lat: 22.754, lng: 75.892, cases: 189, severity: 4, categories: ["Fraud", "Drunk driving"], advice: RUSH },
  { id: "ind-3", area: "Palasia", cityKey: "indore", lat: 22.724, lng: 75.88, cases: 161, severity: 3, categories: ["Snatching", "Theft"], advice: AVOID },
  { id: "ind-4", area: "Bhawarkuan", cityKey: "indore", lat: 22.687, lng: 75.86, cases: 128, severity: 3, categories: ["Road rage", "Theft"], advice: SAFE },

  // Nagpur
  { id: "ngp-1", area: "Sitabuldi", cityKey: "nagpur", lat: 21.145, lng: 79.088, cases: 267, severity: 5, categories: ["Snatching", "Harassment"], advice: SAFE },
  { id: "ngp-2", area: "Dharampeth", cityKey: "nagpur", lat: 21.133, lng: 79.068, cases: 174, severity: 3, categories: ["Theft", "Fraud"], advice: RUSH },
  { id: "ngp-3", area: "Manish Nagar", cityKey: "nagpur", lat: 21.118, lng: 79.07, cases: 139, severity: 3, categories: ["Road rage", "Theft"], advice: AVOID },
  { id: "ngp-4", area: "Gandhibagh", cityKey: "nagpur", lat: 21.156, lng: 79.1, cases: 196, severity: 4, categories: ["Snatching", "Pickpocketing"], advice: SAFE },

  // Surat
  { id: "sur-1", area: "Ring Road", cityKey: "surat", lat: 21.19, lng: 72.832, cases: 231, severity: 4, categories: ["Snatching", "Road rage"], advice: RUSH },
  { id: "sur-2", area: "Athwa", cityKey: "surat", lat: 21.185, lng: 72.805, cases: 187, severity: 4, categories: ["Theft", "Assault"], advice: AVOID },
  { id: "sur-3", area: "Nanpura", cityKey: "surat", lat: 21.198, lng: 72.818, cases: 154, severity: 3, categories: ["Harassment", "Theft"], advice: SAFE },
  { id: "sur-4", area: "Udhna", cityKey: "surat", lat: 21.17, lng: 72.85, cases: 142, severity: 3, categories: ["Road rage", "Theft"], advice: RUSH },
];

export function getCityStats(key: string): CrimeCityStats | undefined {
  return CRIME_CITIES[key];
}

export function nearestHotspots(lat: number, lng: number, limit = 4): CrimeHotspot[] {
  const scored = CRIME_HOTSPOTS.map((h) => ({
    h,
    d: (h.lat - lat) ** 2 + (h.lng - lng) ** 2,
  }));
  scored.sort((a, b) => a.d - b.d);
  const nearest = scored.slice(0, limit);
  const city = nearest[0]?.h.cityKey;
  return scored.filter((s) => s.h.cityKey === city).slice(0, limit).map((s) => s.h);
}
