# Japaika Admin Backend (`admin-backend/`)

Isolated administrative and operations backend API for the **Japaika E-commerce Platform**, built with Node.js, Express 5 (ES Modules), MySQL, and Sequelize ORM.

---

## 1. Architecture & Security Highlights

- **Strict Auth Isolation**: Uses dedicated `admins` and `admin_refresh_tokens` tables (`CHAR(36)` UUID v4), distinct `ADMIN_JWT_*` secrets, `iss: "japaika-admin-backend"`, `aud: "japaika-admin"`, `subType: "admin"`, and `japaika_admin_*` `HttpOnly` cookies. Customer tokens from `user-backend` are never accepted.
- **Email + Password (`bcryptjs`)**: Constant-time password verification with dummy-hash comparison on unknown emails to prevent timing-based account enumeration.
- **No Public Registration**: Admin accounts cannot self-register via public endpoints. The initial `super_admin` is provisioned idempotently via `npm run seed:super-admin` or startup environment variables.
- **Rotating Refresh Tokens & Reuse Detection**: Refresh tokens are stored as SHA-256 hashes in `admin_refresh_tokens` linked by `family_id`. Replaying a previously rotated token immediately revokes the entire session family (`401 REFRESH_TOKEN_REUSE_DETECTED`).
- **Role-Based Access Control (RBAC)**: `requireRoles(...allowedRoles)` enforces `super_admin`, `catalog_manager`, `operations_manager`, and `support_moderator` permissions on protected routes.
- **Shared Database Migration Governance**: `user-backend/` owns all shared MySQL migrations (`user-backend/migrations/`). `admin-backend/` does not run conflicting migrations or `sequelize.sync({ force/alter })`.

---

## 2. Setup & Configuration

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and configure your local MySQL credentials and admin JWT secrets:
   ```bash
   cp .env.example .env
   ```
3. Ensure shared MySQL migrations have been executed from `user-backend/`.
4. (Optional) Seed the initial Super Admin account:
   - Set `INITIAL_SUPER_ADMIN_EMAIL`, `INITIAL_SUPER_ADMIN_PASSWORD`, and `INITIAL_SUPER_ADMIN_NAME` in `.env`, then run:
   ```bash
   npm run seed:super-admin
   ```
5. Start the development server (default port `5001`):
   ```bash
   npm start
   ```

---

## 3. Implemented Endpoints (`/api/v1`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/health` | Public | Liveness & MySQL connectivity check |
| `POST` | `/api/v1/auth/login` | Public (rate-limited) | Email + Password admin login; sets `HttpOnly` cookies |
| `POST` | `/api/v1/auth/refresh` | `japaika_admin_refresh` cookie | Rotates refresh token & issues new access + refresh cookies |
| `POST` | `/api/v1/auth/logout` | Optional | Revokes current refresh token & clears auth cookies |
| `POST` | `/api/v1/auth/logout-all` | `japaika_admin_access` cookie | Revokes all active sessions for the current admin |
| `GET` | `/api/v1/auth/me` | `japaika_admin_access` cookie | Returns currently authenticated admin profile & RBAC role |

See [../docs/ADMIN_API_CONTRACTS.md](../docs/ADMIN_API_CONTRACTS.md) for full request/response contracts.

---

## 4. Running Automated Tests

Run the isolated unit and integration test suite (requires no running MySQL server and never modifies shared databases):

```bash
npm test
```
