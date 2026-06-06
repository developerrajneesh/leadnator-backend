# Leadnator — Backend

AI-powered lead management SaaS. Express + MongoDB + JWT.

## Folder layout

```
backend/
  server.js              # entry
  config/
    db.js                # mongoose connect
    plans.js             # plan definitions + pricing helper
  models/
    User.js  Lead.js  Campaign.js  Subscription.js
  middleware/
    auth.js              # JWT protect + role authorize
    plan.js              # requireFeature + checkLeadLimit
  controllers/
    authController.js
    leadController.js
    aiController.js      # OpenAI + mock fallback
    campaignController.js
    subscriptionController.js
    adminController.js
  routes/
    auth.js  leads.js  ai.js  campaigns.js  subscriptions.js  admin.js
  .env.example
```

## Getting started

```bash
cd backend
cp .env.example .env          # fill MONGO_URI, JWT_SECRET, ...
npm install
npm run dev                    # with nodemon
# or
npm start
```

Server: `http://localhost:5000`.
Health: `GET /api/health`.

## API overview

| Method | Path                           | Auth   | Notes |
|--------|--------------------------------|--------|-------|
| POST   | /api/auth/signup               | —      | Create user |
| POST   | /api/auth/login                | —      | Returns JWT |
| GET    | /api/auth/me                   | user   | Current user |
| GET    | /api/leads                     | user   | List w/ `q`, `status`, `source`, `page`, `limit` |
| POST   | /api/leads                     | user   | Respects plan lead limit |
| POST   | /api/leads/import              | user   | CSV upload, `multipart/form-data` field `file` |
| PUT    | /api/leads/:id                 | user   | |
| DELETE | /api/leads/:id                 | user   | |
| POST   | /api/ai/generate               | Growth+| `{ type: ad|email|close, prompt, tone }` |
| GET    | /api/campaigns                 | user   | |
| POST   | /api/campaigns                 | user   | |
| POST   | /api/campaigns/:id/send        | Growth+| Sends via SMTP, mock when unset |
| GET    | /api/subscriptions/plans       | —      | |
| GET    | /api/subscriptions/quote       | —      | `?plan=growth&duration=yearly` |
| POST   | /api/subscriptions/subscribe   | user   | |
| GET    | /api/admin/users               | admin  | |
| PUT    | /api/admin/users/:id/plan      | admin  | |

## Plan limits

| Plan    | Price  | Leads     | AI  | Meta | Adv Email | API | Team |
|---------|--------|-----------|-----|------|-----------|-----|------|
| Starter | ₹299   | 100       | —   | —    | —         | —   | —    |
| Growth  | ₹499   | 500       | ✓   | ✓    | ✓         | —   | —    |
| Pro     | ₹999   | unlimited | ✓   | ✓    | ✓         | ✓   | ✓    |

Discounts: monthly / 3 mo (-5%) / 6 mo (-10%) / yearly (-15%).

Enforced by `middleware/plan.js`:

- `requireFeature("ai")` → HTTP 402 with `{ upgrade: true }` if not entitled.
- `checkLeadLimit` → HTTP 402 once the user hits their cap.
