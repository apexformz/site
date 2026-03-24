# SmartCoach – AI-Powered Sports Training Platform

SmartCoach is a production-grade sports training platform that uses real-time AI pose estimation to provide athletes with instant, personalized feedback on their technique.

## 🚀 Quick Start (Docker)

The entire system can be launched with a single command:

```bash
docker-compose up --build
```

Access the application at: `http://localhost:3000`

## 🏗️ Architecture

- **Frontend**: Next.js 14 (App Router) with TailwindCSS, Framer Motion, and TensorFlow.js.
- **Backend API**: Node.js + Express + TypeScript, using Prisma and Socket.IO for real-time relay.
- **AI Service**: Python 3.11 + FastAPI with custom trigonometry-based pose analysis.
- **Database**: PostgreSQL for persisting sessions, progress, and leaderboards.

## 🛠️ Local Development Setup

### 1. Backend
```bash
cd apps/backend
npm install
# Copy .env.example to .env and configure DATABASE_URL
npx prisma migrate dev
npm run dev
```

### 2. AI Service
```bash
cd apps/ai-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. Frontend
```bash
cd apps/frontend
npm install
# Copy .env.example to .env
npm run dev
```

## 🧠 Core Features

- **Real-Time Skeleton Overlay**: Browser-based inference using MoveNet.
- **Duplex Feedback Loop**: 30 FPS keypoint streaming to AI service with ms-latency response.
- **Smart Scoring**: Dynamic proficiency calculation based on joint angle variances.
- **Gamification**: XP tracking, level progression, and achievement rewards.
- **Responsive Theme**: Premium Futuristic Dark Mode with Glassmorphism.

## 🛡️ Privacy & Security

- **Edge Processing**: Video frames never leave the client device.
- **Abstract Data Only**: Only keypoint coordinates are sent to the AI service.
- **Secure Auth**: JWT token rotation and secure session management.
