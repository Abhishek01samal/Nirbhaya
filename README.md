# Nirbhaya

> AI-Powered Personal Safety Web Application

Nirbhaya is a full-stack MERN-based real-time personal safety platform designed to help users stay safer during journeys and potentially dangerous situations.

The platform combines **live GPS tracking, ride verification, OCR, route monitoring, AI-assisted voice danger detection, safe-place discovery, crime-area visualization, and hierarchical SOS escalation** into a single safety system.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [How It Works](#how-it-works)
- [Safety Architecture](#safety-architecture)
- [Technology Stack](#technology-stack)
- [System Architecture](#system-architecture)
- [Project Structure](#project-structure)
- [Team Responsibilities](#team-responsibilities)
- [Safety Session](#safety-session)
- [Live Location Tracking](#live-location-tracking)
- [Ride Screenshot and OCR](#ride-screenshot-and-ocr)
- [Ride Lifecycle](#ride-lifecycle)
- [Route Monitoring](#route-monitoring)
- [Prolonged Stop Detection](#prolonged-stop-detection)
- [Safety Event Contract](#safety-event-contract)
- [Safe Places](#safe-places)
- [Safe Route](#safe-route)
- [Crime Map](#crime-map)
- [Transport Search](#transport-search)
- [AI Voice Safety](#ai-voice-safety)
- [AI Assistant](#ai-assistant)
- [SOS Architecture](#sos-architecture)
- [Real-Time Communication](#real-time-communication)
- [Database Design](#database-design)
- [REST API](#rest-api)
- [Socket Events](#socket-events)
- [Environment Variables](#environment-variables)
- [Installation](#installation)
- [Development Roadmap](#development-roadmap)
- [Testing](#testing)
- [Security and Privacy](#security-and-privacy)
- [Git Workflow](#git-workflow)
- [Implementation Checklist](#implementation-checklist)
- [Architecture Principles](#architecture-principles)
- [End-to-End Flow](#end-to-end-flow)
- [Project Goal](#project-goal)

---

# Overview

Nirbhaya works as a real-time safety layer around a user's journey.

A user can start a safety session, share their live location with consent, upload a ride-booking screenshot, and allow the system to monitor their journey.

The platform continuously evaluates multiple safety signals:

- Live GPS location
- Expected travel route
- Ride information
- Route deviation
- Prolonged unexpected stops
- AI-analyzed voice signals
- Manual SOS

Potential safety events are passed to the SOS system for verification and escalation.

### Core Principle

```text
DETECT
   ↓
VERIFY
   ↓
RESPOND
```

The journey and AI modules detect potential risks.

The SOS module handles verification and emergency escalation.

---

# Features

| Feature | Description |
|---|---|
| Safety Sessions | Start and manage a protected journey |
| Live Location | Track the user's location with consent |
| Ride Screenshot | Upload an Uber/Ola/other ride screenshot |
| OCR Extraction | Extract driver, vehicle, plate, pickup and destination |
| Ride Confirmation | Review and confirm extracted ride information |
| Route Monitoring | Compare live GPS with the expected route |
| Route Deviation | Detect persistent movement away from the planned route |
| Prolonged Stop | Detect unexpected stationary periods |
| Safe Places | Find nearby safe locations |
| Safe Routes | Generate routes to safe places |
| Crime Map | Visualize crime-risk information |
| Transport Search | Search bus, train and flight options |
| AI Voice Safety | Analyze consented voice data |
| Manual SOS | Trigger an emergency manually |
| SOS Verification | Verify automatic safety events |
| Guardian Escalation | Notify trusted guardians |
| Nearby Responders | Escalate to nearby responders |
| Emergency Escalation | Continue escalation when required |
| Real-Time Calling | Support emergency communication |
| AI Assistant | Provide conversational safety assistance |
| Dashboard | Display safety and journey information |
| Feedback | Collect user feedback |

---

# How It Works

A typical journey follows this flow:

```text
User
 │
 ▼
Start Safety Session
 │
 ▼
Grant Location Permission
 │
 ▼
Upload Ride Screenshot
 │
 ▼
OCR Extracts Ride Information
 │
 ▼
User Confirms Ride
 │
 ▼
Ride Starts
 │
 ▼
Expected Route Generated
 │
 ▼
Live GPS Monitoring
 │
 ├───────────────┐
 ▼               ▼
OFF_ROUTE      LONG_STOP
 │               │
 └───────┬───────┘
         ▼
   SAFETY EVENT
         │
         ▼
 SOS VERIFICATION
         │
    ┌────┴────┐
    │         │
   SAFE    NO RESPONSE /
    │      NEEDS HELP
    ▼         │
 CANCEL       ▼
           SOS ACTIVE
               │
       ┌───────┼────────┐
       ▼       ▼        ▼
   Guardian Responders Emergency
```

---

# Safety Architecture

The system separates **risk detection** from **emergency response**.

```text
Journey Module
      │
      ├── OFF_ROUTE
      │
      └── LONG_STOP
             │
             ▼
       Safety Event
             │
             ▼
        SOS Module
             │
             ▼
        Verification
             │
       ┌─────┴─────┐
       ▼           ▼
     Cancel       Activate
                   SOS
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      Guardian  Responders Emergency
```

The voice AI module can generate:

```text
VOICE_DANGER
```

Person 1's SOS module is responsible for the final emergency state machine.

---

# Technology Stack

## Frontend

- React
- React Router
- Axios / Fetch
- Socket.IO Client
- Browser Geolocation API
- Browser Media APIs
- Google Maps JavaScript API

## Backend

- Node.js
- Express.js
- MongoDB
- Mongoose
- Socket.IO
- JWT
- Multer
- Axios
- Cloudinary

## External Services

| Service | Purpose |
|---|---|
| Google Maps | Maps, routes, directions and places |
| Cloudinary | Image and media storage |
| OCR Provider | Ride screenshot analysis |
| Transcription API | Audio-to-text conversion |
| Translation API | Language translation |
| AI / LLM | Voice risk analysis and AI assistant |
| Tavily | Web search |
| LiveKit / ZEGOCLOUD | Real-time calling |

---

# System Architecture

```text
                         ┌─────────────────────┐
                         │   React Frontend    │
                         └──────────┬──────────┘
                                    │
                       ┌────────────┴────────────┐
                       │                         │
                    REST API                 Socket.IO
                       │                         │
                       └────────────┬────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │   Node.js + Express │
                         └──────────┬──────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
          Modules                Services              Sockets
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │       MongoDB       │
                         └─────────────────────┘
                                    │
                         External Integrations
                                    │
              ┌─────────┬───────────┼──────────┬─────────┐
              ▼         ▼           ▼          ▼         ▼
           Maps       OCR       Cloudinary     AI      Calling
```

---

# Project Structure

```text
Nirbhaya/
│
├── client/
│   └── ...                         # React frontend
│
├── server/
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
│       │   │
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
```

---

# Team Responsibilities

## Person 1 — Emergency & Communication

### Responsible Modules

```text
modules/sos/
modules/guardians/
integrations/calling/
socket/sos.socket.js
socket/calling.socket.js
jobs/sosEscalation.job.js
```

### Responsibilities

- Manual SOS
- SOS verification
- Accidental SOS handling
- SOS timeout
- SOS state machine
- Guardian notification
- Nearby responder escalation
- Emergency escalation
- SOS history
- Calling

---

## Person 2 — Journey & Location Safety

### Responsible Modules

```text
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
```

### Responsibilities

- GPS tracking
- Safety sessions
- Ride screenshot processing
- OCR
- Driver information extraction
- Vehicle information extraction
- Number plate extraction
- Route generation
- Route deviation detection
- Prolonged-stop detection
- Safe places
- Crime data
- Transport search
- Journey-related safety events

---

## Person 3 — AI & Platform

### Responsible Modules

```text
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
```

### Responsibilities

- Authentication
- User profiles
- Voice monitoring
- Transcription
- Translation
- AI danger detection
- AI assistant
- Web search
- Dashboard
- Feedback

---

# Safety Session

A safety session represents a user's active protected journey.

It connects:

```text
User
 │
 ├── Location
 │
 ├── Ride
 │
 ├── Voice Monitoring
 │
 ├── Safety Events
 │
 └── SOS
```

Example:

```json
{
  "userId": "USER_ID",
  "status": "ACTIVE",
  "startLocation": {
    "lat": 22.346,
    "lng": 87.232
  },
  "destination": {
    "lat": 22.340,
    "lng": 87.320
  },
  "settings": {
    "locationTracking": true,
    "voiceMonitoring": true,
    "rideMonitoring": true
  }
}
```

---

# Live Location Tracking

The browser uses the Geolocation API.

```text
Browser
   │
   │ GPS coordinates
   ▼
Socket.IO
   │
   ▼
Location Service
   │
   ├──► MongoDB
   │
   ├──► Safety Session
   │
   ├──► Route Monitor
   │
   └──► Stop Detector
```

Each location record contains:

```text
userId
safetySessionId
coordinates
accuracy
speed
timestamp
```

MongoDB uses a `2dsphere` index for geospatial queries.

---

# Ride Screenshot and OCR

The user can upload an Uber, Ola, or other ride-booking screenshot.

```text
Ride Screenshot
      │
      ▼
    Multer
      │
      ▼
  Cloudinary
      │
      ▼
   OCR API
      │
      ▼
Structured Ride Data
      │
      ▼
User Confirmation
      │
      ▼
  Ride Record
```

The OCR pipeline attempts to extract:

```text
Platform
Driver Name
Driver Phone
Vehicle Model
Number Plate
Pickup
Destination
```

OCR results must be reviewable because OCR can produce incorrect information.

---

# Ride Lifecycle

```text
CREATED
   │
   ▼
CONFIRMED
   │
   ▼
ACTIVE
   │
   ▼
COMPLETED
```

A ride can also be cancelled:

```text
CREATED ──────► CANCELLED
CONFIRMED ────► CANCELLED
ACTIVE ───────► CANCELLED
```

---

# Route Monitoring

When a ride starts:

```text
Pickup + Destination
        │
        ▼
   Google Maps
        │
        ▼
 Expected Route
        │
        ▼
    Live GPS
        │
        ▼
Distance Calculation
        │
        ▼
Persistent Deviation
        │
        ▼
    OFF_ROUTE
```

A single inaccurate GPS point should never be treated as proof of danger.

The monitoring system considers:

- GPS accuracy
- Temporary signal loss
- Urban GPS noise
- Short deviations
- Alternative routes
- Destination proximity

---

# Prolonged Stop Detection

```text
Vehicle Stops
      │
      ▼
 Start Timer
      │
      ▼
Near Destination?
   │          │
  YES         NO
   │          │
   ▼          ▼
 Ignore    Continue Timer
               │
               ▼
        Threshold Reached
               │
               ▼
           LONG_STOP
```

Short traffic stops should not automatically trigger an emergency.

---

# Safety Event Contract

Journey modules generate standardized safety events.

## OFF_ROUTE

```json
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
```

## LONG_STOP

```json
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
```

These events are sent to the SOS system.

The journey module does **not** implement its own SOS state machine.

---

# Safe Places

The application can search for nearby safe locations.

Possible categories include:

- Police stations
- Hospitals
- Fire stations
- Verified safety centers
- Approved partner locations

Example:

```http
GET /api/v1/safe-places/nearby?lat=22.57&lng=88.36&radius=5000
```

---

# Safe Route

A user can select a safe place and request a route.

```text
Current Location
       │
       ▼
  Selected Safe Place
       │
       ▼
Google Maps Directions
       │
       ▼
    Safe Route
       │
       ▼
  Frontend Map
```

---

# Crime Map

Crime information is stored as geospatial records.

Example data:

```text
Source
Year
Category
Location
Address
Description
```

The frontend can visualize risk levels geographically.

```text
Lower Risk   → Lower Intensity
Medium Risk  → Medium Intensity
High Risk    → Red
```

Crime datasets should retain their source and year.

---

# Transport Search

Guardians can search for transportation options to reach the user's location.

Supported categories:

```text
BUS
TRAIN
FLIGHT
```

Example normalized response:

```json
{
  "type": "TRAIN",
  "operator": "Example Rail",
  "number": "12345",
  "departure": "18:30",
  "arrival": "21:45",
  "duration": "3h 15m"
}
```

---

# AI Voice Safety

The voice monitoring system works using time-based batches.

```text
Browser Microphone
        │
        ▼
Audio Capture
        │
        ▼
1-Minute Audio Batch
        │
        ▼
Transcription
        │
        ▼
Optional Translation
        │
        ▼
AI Risk Analysis
        │
        ▼
Structured Result
        │
        ▼
VOICE_DANGER
```

Example AI result:

```json
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
```

The AI does not directly activate SOS.

It generates a safety signal that is handled by the SOS module.

---

# AI Assistant

The AI assistant can help users with:

- Safety guidance
- Travel information
- Application assistance
- Current information
- Safety alert explanations
- General safety questions

Tavily can be used when the assistant needs current web information.

---

# SOS Architecture

## Automatic Safety Event

```text
OFF_ROUTE
LONG_STOP
VOICE_DANGER
     │
     ▼
Safety Verification
     │
     ▼
"Are you safe?"
     │
 ┌───┴────────┐
 │            │
YES       NO RESPONSE
 │            │
 ▼            ▼
Cancel      Timeout
              │
              ▼
          SOS ACTIVE
              │
      ┌───────┼────────┐
      ▼       ▼        ▼
   Guardian Responders Emergency
```

## Manual SOS

```text
User Presses SOS
       │
       ▼
Accidental Trigger Check
       │
   ┌───┴───┐
   │       │
  YES      NO
   │       │
Cancel    SOS
```

This helps prevent accidental triggers while still allowing automatic escalation when the user cannot respond.

---

# Real-Time Communication

Socket.IO is used for real-time application events.

## Location Events

```text
location:update
location:current
location:error
```

## Ride Events

```text
ride:started
ride:locationUpdated
ride:offRoute
ride:longStop
ride:completed
```

## SOS Events

```text
sos:triggered
sos:verification
sos:activated
sos:cancelled
sos:escalated
sos:resolved
```

---

# Database Design

## Users

```js
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
```

## Guardians

```js
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
```

## Safety Sessions

```js
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
```

## Locations

```js
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
```

## Rides

```js
{
  _id,
  userId,
  safetySessionId,
  platform,
  screenshot,
  driver,
  vehicle,
  pickup,
  destination,
  expectedRoute,
  status,
  monitoring,
  startedAt,
  completedAt,
  createdAt,
  updatedAt
}
```

## Application Data

```js
{
  _id,
  type,
  name,
  category,
  location: {
    type: "Point",
    coordinates: [lng, lat]
  },
  metadata,
  createdAt,
  updatedAt
}
```

---

# REST API

Base URL:

```text
/api/v1
```

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health |
| POST | `/safety-sessions` | Create safety session |
| GET | `/safety-sessions/active` | Get active session |
| POST | `/safety-sessions/:id/end` | End session |
| POST | `/location` | Store location |
| GET | `/location/current/:userId` | Get current location |
| GET | `/location/history` | Get location history |
| POST | `/rides/upload` | Upload ride screenshot |
| GET | `/rides/:id` | Get ride |
| POST | `/rides/:id/confirm` | Confirm ride data |
| POST | `/rides/:id/start` | Start ride monitoring |
| POST | `/rides/:id/stop` | Stop ride monitoring |
| GET | `/safe-places/nearby` | Find nearby safe places |
| GET | `/safe-places/route` | Generate safe route |
| GET | `/crime/incidents` | Get crime incidents |
| GET | `/crime/heatmap` | Get crime heatmap |
| GET | `/transport/search` | Search transportation |

---

# Socket Events

## Location

```text
location:update
location:current
location:error
```

## Ride

```text
ride:started
ride:locationUpdated
ride:offRoute
ride:longStop
ride:completed
```

## SOS

```text
sos:triggered
sos:verification
sos:activated
sos:cancelled
sos:escalated
sos:resolved
```

---

# Environment Variables

Create:

```text
server/.env
```

Example:

```env
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
```

Never commit `.env`.

Use `.env.example` for variable names without secrets.

---

# Installation

## Prerequisites

- Node.js
- npm
- MongoDB or MongoDB Atlas
- Git

## Backend Setup

```bash
cd server
npm install
```

Install required packages:

```bash
npm install express mongoose cors dotenv jsonwebtoken multer socket.io axios cloudinary
```

Install development dependency:

```bash
npm install -D nodemon
```

## ES Modules

Add this to `package.json`:

```json
{
  "type": "module"
}
```

## Scripts

```json
{
  "scripts": {
    "dev": "nodemon src/server.js",
    "start": "node src/server.js"
  }
}
```

## Run Development Server

```bash
npm run dev
```

Server:

```text
http://localhost:8000
```

Health check:

```text
http://localhost:8000/api/v1/health
```

Expected response:

```json
{
  "success": true,
  "message": "Safety backend is running"
}
```

---

# Development Roadmap

## Phase 1 — Backend Foundation

```text
package.json
.env
config/env.js
config/db.js
app.js
server.js
middleware/error.js
```

## Phase 2 — Safety Session

```text
SafetySession Model
SafetySession Service
SafetySession Controller
SafetySession Routes
```

## Phase 3 — Location

```text
Location Model
Location Service
Location Controller
Location Routes
Location Socket
```

## Phase 4 — Ride

```text
Ride Model
Ride Service
Ride Controller
Ride Routes
Cloudinary
OCR
Upload Middleware
```

## Phase 5 — Google Maps

```text
Expected Route
Distance Calculation
Nearby Places
Safe Routes
```

## Phase 6 — Monitoring

```text
Route Deviation
Prolonged Stop
Safety Events
```

## Phase 7 — Safety Data

```text
Safe Places
Crime Map
Transport Search
```

## Phase 8 — Team Integration

```text
Person 2
   │
   ├── OFF_ROUTE
   │
   └── LONG_STOP
          │
          ▼
      Person 1 SOS


Person 3
   │
   └── VOICE_DANGER
          │
          ▼
      Person 1 SOS
```

---

# Testing

## Safety Sessions

- [ ] Create session
- [ ] Prevent duplicate active sessions
- [ ] Get active session
- [ ] End session
- [ ] Verify ownership

## Location

- [ ] Validate coordinates
- [ ] Save location
- [ ] Get current location
- [ ] Get location history
- [ ] Test Socket.IO
- [ ] Handle GPS accuracy

## Ride

- [ ] Upload screenshot
- [ ] Validate file type
- [ ] Validate file size
- [ ] OCR extraction
- [ ] Handle OCR failure
- [ ] Confirm ride data
- [ ] Start ride
- [ ] Stop ride

## Route Monitoring

- [ ] Normal route
- [ ] Small deviation
- [ ] Persistent deviation
- [ ] GPS noise
- [ ] Poor accuracy
- [ ] Destination arrival

## Stop Detection

- [ ] Short stop
- [ ] Long stop
- [ ] Stop at destination
- [ ] Stop away from destination
- [ ] Traffic-like stop

## External Integrations

- [ ] Google Maps success
- [ ] Google Maps timeout
- [ ] OCR failure
- [ ] Cloudinary failure
- [ ] Transport provider failure
- [ ] AI provider failure

---

# Security and Privacy

Nirbhaya processes sensitive information, so privacy and security are core requirements.

## Location

Location tracking requires user consent.

## Voice

Voice monitoring requires explicit user consent.

## Ride Data

Ride screenshots may contain:

- Driver details
- Phone numbers
- Addresses
- Payment information
- Trip information

Only necessary information should be retained.

## Never Log

```text
Passwords
JWT tokens
API secrets
Full payment card numbers
Private audio
Unnecessary phone numbers
Sensitive location data
```

## Authorization

Users should only access their own:

- Safety sessions
- Location history
- Ride information
- Uploaded media

Guardian access should only expose information allowed by the active safety workflow.

---

# Security Checklist

- [ ] `.env` added to `.gitignore`
- [ ] Secure JWT secret
- [ ] CORS configured
- [ ] Upload limits enabled
- [ ] File types validated
- [ ] Authentication enforced
- [ ] Authorization enforced
- [ ] WebSocket authentication
- [ ] Sensitive logs removed
- [ ] API timeouts configured
- [ ] HTTPS enabled in production
- [ ] Rate limiting configured
- [ ] Database backups configured
- [ ] Data retention policy defined

---

# Git Workflow

Recommended branches:

```text
main
develop
```

Feature branches:

```text
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
```

Example commits:

```text
feat: add safety session model
feat: add live location tracking
feat: add ride screenshot upload
feat: integrate OCR
feat: add route deviation detection
feat: add prolonged stop detection
feat: add safe place search
feat: add crime heatmap endpoint
fix: ignore inaccurate GPS points
```

---

# Implementation Checklist

## Backend

- [ ] Express server
- [ ] MongoDB connection
- [ ] Environment configuration
- [ ] Error handling
- [ ] Authentication
- [ ] Authorization
- [ ] Socket.IO

## Journey Safety

- [ ] Safety sessions
- [ ] Live location
- [ ] Location history
- [ ] Ride screenshot upload
- [ ] OCR
- [ ] Ride confirmation
- [ ] Expected route
- [ ] Route monitoring
- [ ] Route deviation
- [ ] Prolonged stop detection

## Safety Data

- [ ] Safe places
- [ ] Safe routes
- [ ] Crime incidents
- [ ] Crime heatmap
- [ ] Transport search

## AI

- [ ] Audio capture
- [ ] Transcription
- [ ] Translation
- [ ] Batch processing
- [ ] Risk analysis
- [ ] `VOICE_DANGER`
- [ ] AI assistant

## Emergency

- [ ] Manual SOS
- [ ] Safety verification
- [ ] Timeout handling
- [ ] Guardian escalation
- [ ] Nearby responder escalation
- [ ] Emergency escalation
- [ ] Calling

---

# Architecture Principles

## 1. Detection Is Not Escalation

```text
Detection
    ↓
Safety Event
    ↓
SOS Verification
    ↓
Emergency Escalation
```

## 2. Keep Controllers Thin

```text
Route
  ↓
Controller
  ↓
Service
  ↓
Database / Integration
```

## 3. Isolate External Services

External APIs should not be scattered throughout controllers.

```text
Business Service
      │
      ├── Google Maps
      ├── OCR
      ├── Cloudinary
      ├── AI
      └── Transport Provider
```

## 4. Treat GPS as Probabilistic

GPS can be inaccurate.

Use:

- Accuracy
- Persistence
- Thresholds
- Multiple observations

before generating a safety event.

## 5. Consent First

Location and voice monitoring must be explicitly enabled by the user.

## 6. Minimize Sensitive Data

Store only the information required to provide the safety service.

## 7. Keep Integrations Replaceable

External providers should be isolated so they can be replaced without rewriting core application logic.

---

# End-to-End Flow

```text
                         USER
                           │
                           ▼
                  START SAFETY SESSION
                           │
                           ▼
                    SHARE LOCATION
                           │
                           ▼
                  UPLOAD RIDE SCREENSHOT
                           │
                           ▼
                          OCR
                           │
                           ▼
                   CONFIRM RIDE DATA
                           │
                           ▼
                       START RIDE
                           │
                           ▼
                    EXPECTED ROUTE
                           │
                           ▼
                    LIVE GPS TRACKING
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
          OFF_ROUTE     LONG_STOP   VOICE_DANGER
              │            │            │
              └────────────┼────────────┘
                           ▼
                     SAFETY EVENT
                           │
                           ▼
                    SOS VERIFICATION
                           │
                           ▼
                     SOS ACTIVATED
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
          GUARDIAN      RESPONDERS   EMERGENCY
```

---

# Project Goal

Nirbhaya aims to create a **real-time, intelligent and privacy-conscious personal safety platform** that can:

1. Understand the user's journey.
2. Monitor movement with consent.
3. Verify ride information.
4. Detect unusual journey behavior.
5. Analyze potential voice-based danger.
6. Give the user an opportunity to respond.
7. Escalate emergencies when necessary.
8. Keep trusted contacts informed.
9. Help responders reach the user.
10. Provide useful safety information throughout the journey.

---

# Final Safety Model

```text
          DETECT
             ↓
          VERIFY
             ↓
          RESPOND
```

Nirbhaya is designed around this simple principle:

> **Detect potential danger early, verify the situation before escalating whenever possible, and respond through a structured emergency workflow when help is required.**
