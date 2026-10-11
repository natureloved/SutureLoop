# SutureLoop — Production Deployment & Live Operations Guide

This guide details how to transition **SutureLoop** from the local demo into a live, autonomous self-healing production platform monitoring your organization's microservices.

---

## 🏛️ High-Level Production Architecture

```
┌─────────────────────────────────┐
│     Production Microservices     │
│  (Node.js / Python / Go / Java) │
└────────────────┬────────────────┘
                 │ 1. Intercept Uncaught Exception (Middleware / OpenTelemetry)
                 ▼
┌─────────────────────────────────┐
│  neatlogs Telemetry Platform    │ ───► Cloud Dashboard (Audit Traces)
└────────────────┬────────────────┘
                 │ 2. Webhook: POST /api/v1/incidents/ingest
                 ▼
┌─────────────────────────────────┐
│     SUTURELOOP AGENT DAEMON     │
│  (Docker / K8s / Cloud Runner)  │
├─────────────────────────────────┤
│ 3. AST Blast Radius (Entire)    │ ───► Fences minimal call-graph scope
│ 4. Atomic Checkpoint (Safety)   │ ───► Hash-locked state (225ms rollback)
│ 5. Synthesis & Test (Vitest)    │ ───► Auto-synthesizes regression suite
│ 6. Unit Economics (cfo.ai)      │ ───► Meters token spend ($0.0011 avg)
└────────────────┬────────────────┘
                 │ 7. Autonomous Git Pull Request
                 ▼
┌─────────────────────────────────┐
│     GitHub / GitLab Remote      │
│  Branch: sutureloop/fix-inc-xxx │ ───► Opens PR with verified diff & test
└────────────────┬────────────────┘
                 │ 8. CI/CD Pipeline (Canary 5% → 100%)
                 ▼
┌─────────────────────────────────┐
│     Production Verification     │ ───► Zero human pager duty required!
└─────────────────────────────────┘
```

---

## 🚀 Step 1: Connecting Production Microservices

Any microservice in your stack can connect to SutureLoop in one of two ways:

### Option A: SutureLoop Drop-In Express Middleware
Add the lightweight interceptor to your Express/Node application:

```typescript
import express from 'express';
import { sutureLoopMiddleware } from './src/middleware/sutureloop.js';

const app = express();

// Your microservice routes...
app.get('/api/orders', orderHandler);

// Attach SutureLoop error interceptor at bottom of middleware stack:
app.use(sutureLoopMiddleware({
  serviceName: 'orders-service',
  sutureLoopIngestUrl: 'https://sutureloop.internal.yourcompany.com/api/v1/incidents/ingest'
}));
```

### Option B: neatlogs Cloud Webhook
In your neatlogs dashboard ([app.neatlogs.com](https://app.neatlogs.com)):
1. Navigate to **Project Settings** → **Webhooks & Alerting**.
2. Add a Webhook URL: `https://sutureloop.internal.yourcompany.com/api/v1/incidents/ingest`.
3. Event Trigger: Select **Fatal Exception Spans** and **CrashLoopBackOff**.

---

## 🔑 Step 2: Production Environment Variables

Configure your `.env` file for production operations:

```env
# 1. Server Configuration
PORT=3000
NODE_ENV=production

# 2. neatlogs Telemetry
NEATLOGS_API_KEY=your_production_neatlogs_key
TRACE_URL_TEMPLATE=https://app.neatlogs.com/traces/${id}

# 3. GitHub Pull Request Automation
# Generate a Personal Access Token or GitHub App Token with repo permissions
GITHUB_TOKEN=ghp_your_github_token_here
GITHUB_REPO=your-org/your-microservice-repo

# 4. LLM Synthesis Provider (Pick one)
OPENROUTER_API_KEY=sk-or-v1-...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...

# 5. Financial Governance (cfo.ai)
DEFAULT_ENGINEER_HOURLY_RATE=125
DEFAULT_INCIDENT_MTTR_MINUTES=45
```

---

## 🚢 Step 3: Deployment Options

### Option 1: Docker (Single Command)
Build and run the containerized agent:

```bash
# Build production image
docker build -t sutureloop .

# Run with environment file
docker run -d \
  -p 3000:3000 \
  --name sutureloop-agent \
  --env-file .env \
  sutureloop
```

Or using `docker-compose`:
```bash
docker compose up -d
```

### Option 2: Railway / Render / Fly.io (One-Click)
1. Fork or push the repository to GitHub.
2. Link your repository in Railway or Render.
3. Add the environment variables from Step 2.
4. Deploy! Your Mission Control Dashboard and Ingest Webhook will be live at `https://your-app.up.railway.app`.

### Option 3: Kubernetes Deployment
Deploy SutureLoop as a persistent operations daemon in your cluster:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sutureloop-agent
  namespace: operations
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sutureloop
  template:
    metadata:
      labels:
        app: sutureloop
    spec:
      containers:
      - name: sutureloop
        image: sutureloop:latest
        ports:
        - containerPort: 3000
        envFrom:
        - secretRef:
            name: sutureloop-secrets
---
apiVersion: v1
kind: Service
metadata:
  name: sutureloop-service
  namespace: operations
spec:
  selector:
    app: sutureloop
  ports:
  - port: 80
    targetPort: 3000
```

---

## 🤖 Step 4: What Happens Live in Production

When an unhandled crash occurs in production:
1. **Crash Interception**: The stack trace and fault coordinates arrive at `/api/v1/incidents/ingest`.
2. **AST Blast Radius**: The **Entire** code graph isolates callers and fences the affected files.
3. **Atomic Checkpoint**: The clean state is hash-locked in `<225ms`.
4. **Adaptive Synthesis & Regression**:
   - Auto-synthesizes a reproduction test.
   - Runs Attempt 1 $\to$ if regression fails, rolls back in 225ms.
   - Runs Attempt 2 with failure context $\to$ all tests pass.
5. **neatlogs Comparative Trace**: Replays the request to confirm zero error rate and normal latency.
6. **cfo.ai Audit**: Computes exact token cost ($0.0011 avg) vs engineering value created ($93.75).
7. **Automated GitHub Pull Request**:
   - Opens an automated PR with the verified patch diff, Vitest proof, neatlogs before/after link, and cfo.ai financial ledger.
   - Triggers your CI/CD canary deployment (e.g. Argo Rollouts 5% canary).

---

## 📊 Live Verification Checklist

- [x] Webhook endpoint active at `/api/v1/incidents/ingest`.
- [x] Drop-in middleware created in `src/middleware/sutureloop.ts`.
- [x] GitHub PR client integrated in `src/github/pr_client.ts`.
- [x] Dockerfile and `docker-compose.yml` verified.
- [x] Mission Control Dashboard accessible at `/dashboard`.
