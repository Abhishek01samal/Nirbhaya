export const vitals = [
  { label: "Heart rate", value: "78", unit: "BPM", level: 64 },
  { label: "Motion", value: "2.4", unit: "/ 10", level: 24 },
  { label: "Sound", value: "38", unit: "DB", level: 32 },
  { label: "Time risk", value: "4.2", unit: "/ 10", level: 42 },
];

export const guardians = [
  { id: "G-01", name: "Anika Rao", relation: "Sister", phone: "+91 •••• 1842", priority: 1, status: "LINKED", lastSeen: "NOW" },
  { id: "G-02", name: "Vikram Rao", relation: "Father", phone: "+91 •••• 9056", priority: 2, status: "LINKED", lastSeen: "04 MIN" },
  { id: "G-03", name: "Maya Sen", relation: "Friend", phone: "+91 •••• 3310", priority: 3, status: "PENDING", lastSeen: "—" },
];

export const agents = [
  { name: "SOS detection", status: "COMPLETED", progress: 100, detail: "Baseline clear" },
  { name: "Location", status: "ACTIVE", progress: 86, detail: "Accuracy ± 7 m" },
  { name: "Threat context", status: "MONITORING", progress: 58, detail: "No distress pattern" },
  { name: "Guardian relay", status: "READY", progress: 100, detail: "2 linked contacts" },
  { name: "Emergency service", status: "WAITING", progress: 0, detail: "Not requested" },
];

export const safetyEvents = [
  { id: "EV-084", time: "14:22:15", date: "25 SEP", type: "LOCATION", title: "Route deviation detected", detail: "Deviation of 184 m from the saved evening route.", state: "REVIEWED" },
  { id: "EV-083", time: "14:20:01", date: "25 SEP", type: "SYSTEM", title: "Device sync stable", detail: "All sensor channels reporting. Latency 42 ms.", state: "VERIFIED" },
  { id: "EV-082", time: "13:48:42", date: "25 SEP", type: "CHECK-IN", title: "Scheduled check-in confirmed", detail: "User confirmed safe arrival at Campus Gate 02.", state: "CLOSED" },
  { id: "EV-081", time: "22:16:08", date: "24 SEP", type: "AI ALERT", title: "Elevated sound and motion", detail: "Context review classified the activity as normal transit.", state: "CLEARED" },
  { id: "EV-080", time: "18:30:00", date: "24 SEP", type: "GUARDIAN", title: "Guardian link accepted", detail: "Anika Rao verified and assigned priority 01.", state: "VERIFIED" },
];

export const settingsGroups = [
  {
    title: "Emergency triggers",
    items: [
      { label: "Automatic SOS at risk 85", detail: "Starts the escalation sequence when combined risk reaches the critical threshold.", enabled: true },
      { label: "Triple-shake trigger", detail: "Requires three strong movements within four seconds.", enabled: true },
      { label: "Voice distress trigger", detail: "Listens locally for configured emergency phrases.", enabled: false },
    ],
  },
  {
    title: "Privacy & evidence",
    items: [
      { label: "Share live location during SOS", detail: "Stops automatically when the emergency session closes.", enabled: true },
      { label: "Emergency audio capture", detail: "Begins only after a confirmed trigger and stays clearly indicated.", enabled: false },
      { label: "Store safety timeline", detail: "Keeps check-ins, alerts, and emergency actions in chronological order.", enabled: true },
    ],
  },
];

export const riskSeries = [28, 31, 29, 34, 38, 35, 42, 47, 45, 51, 49, 56, 53, 48, 46, 44, 41, 43, 39, 42, 46, 44, 47, 46];