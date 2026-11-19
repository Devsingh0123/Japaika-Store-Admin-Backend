# Japaika Admin Backend (`admin-backend/`)

Administrative and operations REST API for the standalone Japaika E-commerce platform, built with **Node.js (ES Modules)**, **Express 5**, **MySQL**, and **Sequelize ORM**.

> **Migration Governance:** `user-backend/` is the designated owner of all shared MySQL migrations (`user-backend/migrations/`). `admin-backend/` consumes the shared schema without running separate migrations or `sequelize.sync({ force/alter })`.

---

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Create `.env` (using `.env.example` as a reference) with your local MySQL credentials (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) and admin JWT secrets (`ADMIN_JWT_ACCESS_SECRET`, `ADMIN_JWT_REFRESH_SECRET`).

3. **Ensure shared MySQL migrations are applied** (from `../user-backend/`):
   ```bash
   npm run migrate
   ```

4. **Seed the initial Super Admin account** *(idempotent; no public registration endpoint exists)*:
   Set `INITIAL_SUPER_ADMIN_EMAIL`, `INITIAL_SUPER_ADMIN_PASSWORD`, and `INITIAL_SUPER_ADMIN_NAME` in `.env`, then run:
   ```bash
   npm run seed:super-admin
   ```

5. **Start the server** (default port `5001`):
   ```bash
   npm run dev   # Development (nodemon)
   npm start     # Production (node)
   ```

---

## Automated Tests

Run all unit and integration tests (uses unique synthetic test emails against local MySQL with automatic per-test cleanup):

```bash
npm test
```

---

## Implemented Endpoints (`/api/v1`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/health` | Public | Service & MySQL connectivity check |
| `POST` | `/api/v1/auth/login` | Public | Email + Password admin login; sets `HttpOnly` JWT cookies |
| `POST` | `/api/v1/auth/refresh` | Refresh Cookie | Rotate refresh token & issue fresh access + refresh cookies |
| `POST` | `/api/v1/auth/logout` | Optional Cookie | Revoke current refresh token & clear auth cookies |
| `POST` | `/api/v1/auth/logout-all` | Access Cookie | Revoke all active refresh tokens for the admin |
| `GET` | `/api/v1/auth/me` | Access Cookie | Get currently authenticated admin profile & RBAC role |
