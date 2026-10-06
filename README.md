# Nirbhaya
AI-Powered Personal Safety Web Application
A full-stack MERN-based real-time personal safety platform that
combines journey monitoring, GPS tracking, ride screenshot/OCR analysis,
route deviation detection, prolonged-stop detection, safe-place
discovery, crime-area visualization, AI-assisted voice danger detection,
and hierarchical SOS escalation.
Project status: Active development
Application type: Web application
Architecture: MERN + REST + Socket.IO + external service
integrations

Table of Contents
- Overview
- Core Features
- How It Works
- Technology Stack
- System Architecture
- Repository Structure
- Team Responsibilities
- Safety Session
- Live Location Tracking
- Ride Screenshot and OCR
- Route Deviation Detection
- Prolonged Stop Detection
- Safety Event Contract
- SOS Flow
- Safe Places
- Crime Map
- Transport Search
- Voice Safety Pipeline
- AI Assistant
- Real-Time Communication
- Database Design
- REST API
- Environment Variables
- Local Development
- Development Workflow
- Testing
- Security and Privacy
- Git Workflow
- Implementation Checklist
- Architecture Principles
Overview
This application is designed to provide a real-time safety layer
around a user's journey.
A user can start a safety session, share their live location with
consent, optionally upload a ride-booking screenshot, and allow the
system to monitor the journey.
The platform can combine multiple signals:
- GPS movement
- Expected route
- Ride information
- Route deviation
- Unexpected prolonged stops
- AI-analyzed voice signals
- Manual SOS
These signals are converted into standardized safety events.
The emergency system then verifies the situation with the user before
escalating when appropriate.
Important design principle
The application separates danger detection from emergency
escalation.
Journey / AI Modules
        |
        | Safety Events
        v
   SOS Module
        |
        v
 Verification
        |
        +---- Cancel
        |
        +---- Activate SOS
                  |
                  v
             Guardian
                  |
                  v
          Nearby Responders
                  |
                  v
        Emergency Services
This prevents different modules from implementing competing SOS logic.
Core Features
  Feature                             Description
  Safety Session                      Represents an active protected
                                      journey
  Live Location                       Tracks the user's GPS location with
                                      consent
  Ride Screenshot                     Accepts an Uber/Ola/other ride
                                      screenshot
  OCR Extraction                      Extracts driver, vehicle, plate,
                                      pickup and destination
  Ride Confirmation                   Lets the user review extracted ride
                                      information
  Route Monitoring                    Compares live GPS against the
                                      expected route
  Route Deviation                     Detects persistent movement away
                                      from the planned route
  Prolonged Stop                      Detects unexpected stationary
                                      periods away from the destination
  Safe Places                         Finds nearby approved safety
                                      locations
  Safe Route                          Generates a route to a selected
                                      safe place
  Crime Map                           Displays crime-risk information
                                      geographically
  Transport Search                    Helps guardians find
                                      bus/train/flight options
  Voice Safety                        Processes consented audio in
                                      batches for AI analysis
  Manual SOS                          Allows the user to initiate an
                                      emergency
  SOS Verification                    Confirms whether an automatically
                                      detected event is accidental
  Guardian Escalation                 Notifies guardians during an active
                                      SOS
  Nearby Responders                   Expands the response radius when
                                      required
  Emergency Escalation                Escalates when configured
                                      conditions are met
  Calling                             Enables authorized real-time voice
                                      communication
  AI Assistant                        Provides conversational safety
                                      assistance
  Dashboard                           Presents journey and safety status
  Feedback                            Collects user feedback
How It Works
A typical journey:
1. User starts a Safety Session
              |
              v
2. User grants location permission
              |
              v
3. User optionally uploads ride screenshot
              |
              v
4. Screenshot -> Cloudinary -> OCR
              |
              v
5. Driver / vehicle / route information extracted
              |
              v
6. User reviews and confirms ride information
              |
              v
7. Ride starts
              |
              v
8. Google Maps generates expected route
              |
              v
9. Browser sends GPS updates
              |
              v
10. Route + stop monitoring begins
              |
       +------+------+
       |             |
       v             v
  OFF_ROUTE      LONG_STOP
       |             |
       +------+------+
              |
              v
       Safety Event
              |
              v
        SOS Verification
              |
       +------+------+
       |             |
     Safe         No response /
       |          needs help
       v             |
     Cancel          v
                  SOS Active
                     |
             +-------+-------+
             |       |       |
             v       v       v
         Guardian  Nearby  Emergency
                   Users   Services
Technology Stack
Frontend
- React
- React Router
- Axios or Fetch
- Socket.IO Client
- Browser Geolocation API
- Browser Media APIs
- Google Maps JavaScript API
Backend
- Node.js
- Express.js
- MongoDB
- Mongoose
- Socket.IO
- JWT
- Multer
- Axios
- Cloudinary
External Integrations
- Google Maps
- Cloudinary
- OCR provider
- Transcription provider
- Translation provider
- AI/LLM provider
- Tavily
- LiveKit and/or ZEGOCLOUD
System Architecture
                         +-------------------+
                         |   React Frontend  |
                         +---------+---------+
                                   |
                    +--------------+--------------+
                    |                             |
                 REST API                    Socket.IO
                    |                             |
                    +--------------+--------------+
                                   |
                         +---------v---------+
                         | Node.js + Express |
                         +---------+---------+
                                   |
             +---------------------+---------------------+
             |                     |                     |
      +------v------+       +------v------+       +------v------+
      |   Modules   |       |   Services  |       |   Sockets   |
      +------+------+       +------+------+       +------+------+
             |                     |                     |
             +----------+----------+----------+----------+
                        |                     |
                 +------v------+       +------v------+
                 |  MongoDB    |       | Integrations|
                 +-------------+       +-------------+
                                             |
                         +-------------------+-------------------+
                         |         |         |        |          |
                         v         v         v        v          v
                      Maps       OCR    Cloudinary    AI     Calling
Repository Structure
project-root/
│
├── client/                         # React frontend
│
├── server/                         # Node.js backend
│   │
│   ├── package.json
│   ├── .env
│   ├── .env.example
│   ├── .gitignore
│   │
│   └── src/
│       │
│       ├── app.js
│       ├── server.js
│       │
│       ├── config/
│       │   ├── db.js
│       │   ├── env.js
│       │   └── cloudinary.js
│       │
│       ├── modules/
│       │   ├── auth/
│       │   ├── users/
│       │   ├── guardians/
│       │   │
│       │   ├── sos/
│       │   │   ├── sos.controller.js
│       │   │   ├── sos.service.js
│       │   │   ├── sos.stateMachine.js
│       │   │   ├── sos.model.js
│       │   │   └── sos.routes.js
│       │   │
│       │   ├── location/
│       │   ├── safetySession/
│       │   ├── voice/
│       │   ├── ride/
│       │   ├── safePlace/
│       │   ├── crime/
│       │   ├── transport/
│       │   ├── assistant/
│       │   ├── dashboard/
│       │   └── feedback/
│       │
│       ├── integrations/
│       │   ├── ai/
│       │   ├── tavily/
│       │   ├── googleMaps/
│       │   ├── transcriber/
│       │   ├── translator/
│       │   ├── ocr/
│       │   ├── cloudinary/
│       │   └── calling/
│       │       ├── livekit.js
│       │       └── zegocloud.js
│       │
│       ├── socket/
│       │   ├── socket.js
│       │   ├── location.socket.js
│       │   ├── sos.socket.js
│       │   ├── ride.socket.js
│       │   └── calling.socket.js
│       │
│       ├── jobs/
│       │   ├── voiceBatch.job.js
│       │   └── sosEscalation.job.js
│       │
│       ├── middleware/
│       │   ├── auth.js
│       │   ├── upload.js
│       │   ├── validate.js
│       │   └── error.js
│       │
│       └── utils/
│           ├── geo.js
│           ├── distance.js
│           └── logger.js
│
└── README.md
Team Responsibilities
Person 1 --- Emergency and Communication
Owns:
modules/sos/
modules/guardians/
integrations/calling/
socket/sos.socket.js
socket/calling.socket.js
jobs/sosEscalation.job.js
Responsibilities:
- Manual SOS
- SOS verification
- Accidental-trigger handling
- SOS timeout
- SOS state machine
- Guardian notification
- Nearby responder escalation
- Emergency escalation
- SOS history
- Real-time SOS events
- Calling authorization/token flow
Person 2 --- Journey and Location Safety
Owns:
modules/location/
modules/safetySession/
modules/ride/
modules/safePlace/
modules/crime/
modules/transport/

integrations/googleMaps/
integrations/ocr/
integrations/cloudinary/

socket/location.socket.js
socket/ride.socket.js

middleware/upload.js
utils/geo.js
utils/distance.js
Responsibilities:
- GPS tracking
- Safety sessions
- Ride screenshot processing
- OCR
- Driver and vehicle extraction
- Expected route generation
- Route deviation detection
- Prolonged-stop detection
- Safe places
- Crime data
- Transport search
- Journey-related safety events
Person 3 --- AI and Platform
Owns:
modules/auth/
modules/users/
modules/voice/
modules/assistant/
modules/dashboard/
modules/feedback/

integrations/ai/
integrations/tavily/
integrations/transcriber/
integrations/translator/

jobs/voiceBatch.job.js
Responsibilities:
- Authentication
- User profile
- Voice monitoring
- Transcription
- Translation
- AI danger analysis
- AI assistant
- Web search
- Dashboard
- Feedback
Safety Session
A safety session represents the user's protected journey.
It connects:
User
 |
 +-- Location
 |
 +-- Ride
 |
 +-- Voice Monitoring
 |
 +-- Safety Events
 |
 +-- SOS
Example:
{
  "userId": "USER_ID",
  "status": "ACTIVE",
  "startLocation": {
    "lat": 22.346,
    "lng": 87.232,
    "address": "IIT Kharagpur Main Gate"
  },
  "destination": {
    "lat": 22.34,
    "lng": 87.32,
    "address": "Kharagpur Bus Stand"
  },
  "settings": {
    "locationTracking": true,
    "voiceMonitoring": true,
    "rideMonitoring": true
  }
}
Live Location Tracking
The frontend uses the browser Geolocation API.
Browser
   |
   | latitude / longitude
   v
Socket.IO
   |
   v
Backend
   |
   +--> Location collection
   |
   +--> SafetySession.lastLocation
   |
   +--> Route monitoring
   |
   +--> Stop detection
Location records contain:
userId
safetySessionId
latitude
longitude
accuracy
speed
timestamp
MongoDB uses a 2dsphere index for geospatial queries.
Ride Screenshot and OCR
The user can upload an Uber, Ola, or other ride-booking screenshot.
Screenshot
    |
    v
Multer
    |
    v
Cloudinary
    |
    v
OCR
    |
    v
Structured Ride Data
    |
    v
User Confirmation
    |
    v
Ride Record
The system can attempt to extract:
Platform
Driver name
Driver phone
Vehicle model
Number plate
Pickup
Destination
OCR output must be considered potentially incorrect. The user should be
able to review and confirm extracted information before ride monitoring
begins.
Route Deviation Detection
When the ride starts:
Pickup + Destination
        |
        v
Google Maps
        |
        v
Expected Route
        |
        v
GPS Monitoring
        |
        v
Distance from Expected Route
        |
        v
Persistent Deviation?
        |
       Yes
        |
        v
OFF_ROUTE
A single inaccurate GPS point should not trigger an emergency.
The route monitor should account for:
- GPS accuracy
- Temporary signal loss
- Urban GPS noise
- Short deviations
- Route alternatives
- Map inaccuracies
- Destination proximity
Prolonged Stop Detection
The system should distinguish between a normal stop and a potentially
concerning stop.
Vehicle stops
      |
      v
Start timer
      |
      v
Near destination?
   /          \
 Yes          No
  |            |
Ignore       Continue
               |
               v
        Threshold reached
               |
               v
          LONG_STOP
Normal traffic stops should not automatically cause an SOS.
Safety Event Contract
Journey modules send standardized events to the SOS module.
OFF_ROUTE
{
  "type": "OFF_ROUTE",
  "userId": "USER_ID",
  "safetySessionId": "SESSION_ID",
  "rideId": "RIDE_ID",
  "location": {
    "lat": 22.5726,
    "lng": 88.3639
  },
  "metadata": {
    "distanceFromRoute": 450
  },
  "timestamp": "2026-10-06T12:00:00.000Z"
}
LONG_STOP
{
  "type": "LONG_STOP",
  "userId": "USER_ID",
  "safetySessionId": "SESSION_ID",
  "rideId": "RIDE_ID",
  "location": {
    "lat": 22.5726,
    "lng": 88.3639
  },
  "metadata": {
    "stationarySeconds": 210
  },
  "timestamp": "2026-10-06T12:05:00.000Z"
}
The receiving SOS module owns the final emergency decision.
SOS Flow
Automatic safety event
OFF_ROUTE / LONG_STOP / VOICE_DANGER
                 |
                 v
          Safety Verification
                 |
                 v
             "Are you safe?"
                 |
          +------+------+
          |             |
         YES         NO RESPONSE
          |             |
          v             v
        Cancel       Timeout
                        |
                        v
                    SOS ACTIVE
Manual SOS
User presses SOS
       |
       v
Accidental trigger check
       |
   +---+---+
   |       |
  YES     NO
   |       |
Cancel    SOS
The verification system should prevent accidental emergency activation
while ensuring that silence or lack of response can still lead to
escalation when configured.
Safe Places
The application can find nearby approved or relevant safety locations.
Possible categories:
- Police stations
- Hospitals
- Fire stations
- Verified public safety centers
- Approved partner locations
Example request:
GET /api/v1/safe-places/nearby?lat=22.57&lng=88.36&radius=5000
Crime Map
Crime information is stored as geospatial records.
Low risk       -> lower visual intensity
Medium risk    -> moderate visual intensity
High risk      -> red
Crime records can include:
Source
Year
Category
Location
Address
Description
NCRB data can be imported and transformed into application-friendly
records where the dataset's terms and applicable requirements permit.
Transport Search
Guardians may need to reach the user's location.
The transport module can search:
Bus
Train
Flight
Example normalized result:
{
  "type": "TRAIN",
  "operator": "Example Rail",
  "number": "12345",
  "departure": "18:30",
  "arrival": "21:45",
  "duration": "3h 15m"
}
Voice Safety Pipeline
Voice monitoring uses a batch-based architecture.
Browser Microphone
        |
        v
Audio Capture
        |
        v
1-Minute Batch
        |
        v
Transcription
        |
        v
Optional Translation
        |
        v
AI Risk Analysis
        |
        v
Structured Risk Result
        |
        v
VOICE_DANGER Event
Example AI result:
{
  "riskDetected": true,
  "riskLevel": "HIGH",
  "confidence": 0.91,
  "signals": [
    "distress",
    "threat",
    "request_for_help"
  ]
}
The AI does not directly execute the SOS state machine.
AI Assistant
The assistant can help with:
- Safety advice
- Travel questions
- Application guidance
- Current information lookup
- Understanding safety alerts
- General safety-related assistance
Tavily can provide web search capabilities when current external
information is required.
Real-Time Communication
Socket.IO handles real-time events.
Location events
location:update
location:current
location:error
Ride events
ride:started
ride:locationUpdated
ride:offRoute
ride:longStop
ride:completed
SOS events
sos:triggered
sos:verification
sos:activated
sos:cancelled
sos:escalated
sos:resolved
Calling
LiveKit or ZEGOCLOUD can handle actual voice transport.
The backend handles:
- Authentication
- Authorization
- Room/session creation
- Token generation
- Call metadata
Database Design
Users
{
  _id,
  name,
  email,
  phone,
  passwordHash,
  role,
  emergencySettings,
  createdAt,
  updatedAt
}
Guardians
{
  _id,
  userId,
  guardianUserId,
  relationship,
  priority,
  status,
  createdAt,
  updatedAt
}
Safety Sessions
{
  _id,
  userId,
  status,
  startLocation,
  destination,
  expectedArrival,
  settings,
  lastLocation,
  startedAt,
  endedAt,
  createdAt,
  updatedAt
}
Locations
{
  _id,
  userId,
  safetySessionId,
  location: {
    type: "Point",
    coordinates: [lng, lat]
  },
  accuracy,
  speed,
  timestamp
}
Rides
{
  _id,
  userId,
  safetySessionId,
  platform,
  screenshot: {
    url,
    publicId
  },
  driver: {
    name,
    phone
  },
  vehicle: {
    model,
    numberPlate
  },
  pickup: {
    address,
    lat,
    lng
  },
  destination: {
    address,
    lat,
    lng
  },
  expectedRoute: {
    coordinates
  },
  status,
  monitoring: {
    lastMovementAt,
    offRoute,
    prolongedStop
  },
  startedAt,
  completedAt,
  createdAt,
  updatedAt
}
Application Data
{
  _id,
  type,
  name,
  category,
  location: {
    type: "Point",
    coordinates: [lng, lat]
  },
  metadata: {
    source,
    sourceYear,
    address,
    description
  },
  createdAt,
  updatedAt
}
REST API
Base URL:
/api/v1
  Method   Endpoint                      Purpose
  POST   /safety-sessions            Create safety session
  GET    /safety-sessions/active     Get active session
  POST   /safety-sessions/:id/end    End session
  POST   /location                   Store location
  GET    /location/current/:userId   Current location
  GET    /location/history           Location history
  POST   /rides/upload               Upload ride screenshot
  GET    /rides/:id                  Get ride
  POST   /rides/:id/confirm          Confirm OCR data
  POST   /rides/:id/start            Start ride
  POST   /rides/:id/stop             Stop ride
  GET    /safe-places/nearby         Find nearby safe places
  GET    /safe-places/route          Route to safe place
  GET    /crime/incidents            Get crime incidents
  GET    /crime/heatmap              Get crime heatmap
  GET    /transport/search           Search transport
  GET    /health                     Server health
Environment Variables
Create:
server/.env
Example:
PORT=8000

MONGO_URI=

JWT_SECRET=

CLIENT_URL=http://localhost:5173

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

GOOGLE_MAPS_API_KEY=

OCR_API_KEY=
OCR_API_URL=

TAVILY_API_KEY=

TRANSCRIBER_API_KEY=
TRANSCRIBER_API_URL=

TRANSLATOR_API_KEY=
TRANSLATOR_API_URL=

AI_API_KEY=
AI_API_URL=

LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_URL=

ZEGO_APP_ID=
ZEGO_SERVER_SECRET=
Never commit .env.
Local Development
Prerequisites
Install:
- Node.js
- npm
- MongoDB or MongoDB Atlas
- Git
Create the project:
git clone <repository-url>
cd <project-folder>
Install backend dependencies:
cd server
npm install
Create:
.env
Start development server:
npm run dev
The backend runs on:
http://localhost:8000
Health check:
GET http://localhost:8000/api/v1/health
Expected response:
{
  "success": true,
  "message": "Safety backend is running"
}
Recommended Package Scripts
{
  "scripts": {
    "dev": "nodemon src/server.js",
    "start": "node src/server.js"
  }
}
For ES modules:
{
  "type": "module"
}
Development Workflow
Build incrementally.
Phase 1 --- Backend Foundation
package.json
.env
config/env.js
config/db.js
app.js
server.js
middleware/error.js
Goal:
Server starts
MongoDB connects
Health endpoint works
Phase 2 --- Safety Session
Implement:
SafetySession model
SafetySession service
SafetySession controller
SafetySession routes
Phase 3 --- Location
Implement:
Location model
Location service
Location controller
Location routes
location.socket.js
Phase 4 --- Ride
Implement:
Ride model
Ride service
Ride controller
Ride routes
Cloudinary integration
OCR integration
upload middleware
Phase 5 --- Maps
Implement:
googleMaps integration
Add:
- Route generation
- Distance calculations
- Nearby places
- Safe routes
Phase 6 --- Monitoring
Implement:
routeMonitor.service.js
stopDetector.service.js
Phase 7 --- Safe Places and Crime
Implement:
safePlace/
crime/
Phase 8 --- Transport
Implement:
transport/
Phase 9 --- Team Integration
Connect:
Person 2
   |
   +--> OFF_ROUTE
   |
   +--> LONG_STOP
             |
             v
        Person 1 SOS
And:
Person 3
   |
   v
VOICE_DANGER
   |
   v
Person 1 SOS
Testing
Test each module independently before integrating.
Safety Sessions
- Create session
- Duplicate active session
- End session
- Unauthorized access
Location
- Valid coordinates
- Invalid coordinates
- Current location
- History
- Socket connection
- Socket disconnection
- GPS accuracy
Ride
- Valid screenshot
- Invalid file
- Large file
- OCR failure
- Missing driver data
- User correction
- Ride start
- Ride stop
Route Monitoring
- Normal route
- Small deviation
- Persistent deviation
- Large deviation
- GPS noise
- Poor accuracy
- Destination arrival
Stop Detection
- Short stop
- Threshold stop
- Stop at destination
- Stop away from destination
- Traffic-like stop
External APIs
- Successful response
- Empty response
- Timeout
- Invalid response
- Provider failure
Security and Privacy
This application processes sensitive information.
Location
Location tracking requires user consent.
Voice
Voice monitoring requires explicit user consent.
Ride Data
Ride screenshots can contain:
- Driver information
- Phone numbers
- Addresses
- Payment information
- Trip details
Only necessary information should be retained.
Logging
Never log:
Passwords
JWT tokens
API secrets
Full payment card numbers
Private audio
Unnecessary phone numbers
Sensitive location data
Good logging:
Safety session started
Ride created
Route monitoring started
OFF_ROUTE detected
LONG_STOP detected
Authorization
Users should only access their own:
- Safety sessions
- Location history
- Ride information
- Uploaded screenshots
Guardian access should be limited to information explicitly shared
through the application's safety flow.
Security Checklist
- [ ] .env excluded from Git
- [ ] Secure JWT secret configured
- [ ] CORS restricted
- [ ] Upload size limits enabled
- [ ] File MIME types validated
- [ ] Authentication enforced
- [ ] Authorization enforced
- [ ] Location access restricted
- [ ] Ride data access restricted
- [ ] Sensitive logs removed
- [ ] Rate limiting considered
- [ ] HTTPS enabled in production
- [ ] WebSocket authentication enabled
- [ ] External API timeouts configured
- [ ] Data retention policy defined
- [ ] Database backups configured
Git Workflow
Recommended branches:
main
develop
Feature branches:
feature/safety-session
feature/location-tracking
feature/ride-upload
feature/ocr
feature/google-maps
feature/route-monitoring
feature/stop-detection
feature/safe-place
feature/crime-map
feature/transport
Example commits:
feat: add safety session model
feat: add browser location ingestion
feat: add ride screenshot upload
feat: integrate OCR
feat: add route deviation detection
feat: add prolonged stop detection
feat: add nearby safe places
feat: add crime heatmap endpoint
fix: ignore inaccurate GPS points
Implementation Checklist
Backend Foundation
- [ ] Express configured
- [ ] MongoDB connected
- [ ] Environment configuration
- [ ] Error middleware
- [ ] Authentication integrated
- [ ] Socket.IO initialized
Safety Session
- [ ] Create session
- [ ] Get active session
- [ ] End session
- [ ] Ownership validation
Location
- [ ] Browser GPS integration
- [ ] Location persistence
- [ ] Current location API
- [ ] History API
- [ ] Socket location updates
- [ ] 2dsphere index
Ride
- [ ] Screenshot upload
- [ ] Cloudinary upload
- [ ] OCR extraction
- [ ] Driver information
- [ ] Vehicle information
- [ ] Number plate
- [ ] Pickup
- [ ] Destination
- [ ] User confirmation
- [ ] Ride lifecycle
Monitoring
- [ ] Expected route
- [ ] GPS accuracy filtering
- [ ] Route deviation detection
- [ ] Persistence threshold
- [ ] Prolonged stop detection
- [ ] Destination detection
- [ ] OFF_ROUTE event
- [ ] LONG_STOP event
Safe Places
- [ ] Nearby search
- [ ] Safe categories
- [ ] Route generation
Crime
- [ ] Dataset ingestion
- [ ] Geospatial storage
- [ ] Incident API
- [ ] Heatmap API
Transport
- [ ] Search endpoint
- [ ] Provider integration
- [ ] Normalized response
Team Integration
- [ ] SOS event contract
- [ ] Voice event contract
- [ ] Shared authentication
- [ ] Shared user IDs
- [ ] Socket event contract
Architecture Principles
1. Detection Is Not Escalation
Journey module
     |
     v
Safety event
     |
     v
SOS module
     |
     v
Emergency state machine
2. Keep Controllers Thin
Route
  |
  v
Controller
  |
  v
Service
  |
  v
Integration / Database
3. Isolate External Providers
Avoid scattering provider-specific API calls throughout controllers.
Use:
Service
   |
   +--> Google Maps integration
   +--> OCR integration
   +--> Cloudinary integration
   +--> AI integration
4. Design for Provider Replacement
The business logic should not depend directly on one vendor.
OCR interface
   |
   +--> Provider A
   +--> Provider B

Maps interface
   |
   +--> Google Maps
   +--> Alternative provider

Calling interface
   |
   +--> LiveKit
   +--> ZEGOCLOUD
5. Treat GPS as Probabilistic Data
Never interpret a single inaccurate coordinate as proof of danger.
6. Require Consent
Location and voice monitoring must be explicit, understandable, and
controllable by the user.
7. Minimize Sensitive Data
Store only what is needed to provide the safety service.
Project Completion Criteria
The application is considered functionally complete when:
[ ] User can authenticate
[ ] User can create a safety session
[ ] User can share location
[ ] User can upload a ride screenshot
[ ] OCR extracts ride information
[ ] User can confirm ride information
[ ] Expected route is generated
[ ] Live ride monitoring works
[ ] Route deviation is detected
[ ] Prolonged stops are detected
[ ] Safe places can be found
[ ] Safe routes can be generated
[ ] Crime data can be displayed
[ ] Transport can be searched
[ ] Voice batches can be analyzed
[ ] Safety events are generated
[ ] SOS verification works
[ ] Guardian escalation works
[ ] Nearby responder escalation works
[ ] Emergency escalation works
[ ] Real-time calling works
[ ] Dashboard displays current state
[ ] Feedback can be submitted
[ ] Authentication and authorization are enforced
[ ] Sensitive information is protected
Final Architecture
                           USER
                            |
                            v
                    +---------------+
                    | Safety Session|
                    +-------+-------+
                            |
       +--------------------+--------------------+
       |                    |                    |
       v                    v                    v
   LOCATION               RIDE                VOICE
       |                    |                    |
       |              +-----+-----+              |
       |              |           |              |
       |              v           v              v
       |             OCR       ROUTE          AI ANALYSIS
       |                          |                |
       +------------+-------------+----------------+
                    |
                    v
             JOURNEY MONITORING
                    |
             +------+------+
             |             |
             v             v
         OFF_ROUTE     LONG_STOP
             |             |
             +------+------+
                    |
                    v
              SAFETY EVENT
                    |
                    v
              SOS MODULE
                    |
          +---------+---------+
          |         |         |
          v         v         v
      GUARDIAN  RESPONDERS  EMERGENCY
The platform's central architectural principle is:
Detect → Verify → Respond

Journey monitoring and AI analysis detect potentially dangerous
conditions. The SOS system verifies the situation and manages emergency
escalation. This separation keeps the application modular, safer to
develop, and easier to test and maintain.
