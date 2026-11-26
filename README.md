# Japaika Admin Backend (`admin-backend/`)

Administrative and operations REST API for the standalone Japaika E-commerce platform, built with **Node.js (ES Modules)**, **Express 5**, **MySQL**, **Sequelize ORM**, **Multer (memory storage)**, and **Cloudinary**.

> **Migration Governance:** `user-backend/` is the designated owner of all shared MySQL migrations (`user-backend/migrations/`). `admin-backend/` consumes the shared schema without running separate migrations or `sequelize.sync({ force/alter })`.

---

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Create `.env` (using `.env.example` as a reference) with your local MySQL credentials (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`), admin JWT secrets (`ADMIN_JWT_ACCESS_SECRET`, `ADMIN_JWT_REFRESH_SECRET`), and Cloudinary credentials (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`).

3. **Ensure shared MySQL migrations are applied** (from `../user-backend/`):
   ```bash
   npm run migrate
   ```

4. **Seed the initial Super Admin account** *(idempotent; prompts interactively for name, email, and password)*:
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

Run all unit and integration tests:

```bash
npm test
```

---

## Implemented Endpoints (`/api/v1`)

| Method | Path | Auth / RBAC | Description |
|---|---|---|---|
| `GET` | `/api/v1/health` | Public | Service & MySQL connectivity check |
| `POST` | `/api/v1/auth/login` | Public | Email + Password admin login; sets `HttpOnly` JWT cookies |
| `POST` | `/api/v1/auth/refresh` | Refresh Cookie | Rotate refresh token & issue fresh access + refresh cookies |
| `POST` | `/api/v1/auth/logout` | Optional Cookie | Revoke current refresh token & clear auth cookies |
| `POST` | `/api/v1/auth/logout-all` | Access Cookie | Revoke all active refresh tokens for the admin |
| `GET` | `/api/v1/auth/me` | Access Cookie | Get currently authenticated admin profile & RBAC role |
| `GET` | `/api/v1/categories` | All Active Admin Roles | List categories with pagination, search, filters, or `?tree=true` |
| `GET` | `/api/v1/categories/:id` | All Active Admin Roles | Get single category with `parent` and `subcategories` |
| `POST` | `/api/v1/categories` | `super_admin`, `catalog_manager` | Create category or subcategory (JSON or `multipart/form-data` with `image`) |
| `PATCH` | `/api/v1/categories/:id` | `super_admin`, `catalog_manager` | Update category/subcategory or replace/remove Cloudinary image |
| `DELETE` | `/api/v1/categories/:id` | `super_admin`, `catalog_manager` | Soft-delete category (if no subcategories/products) & delete Cloudinary image |
| `GET` | `/api/v1/products` | All Active Admin Roles | Paginated product list with search, status, category, type, featured, `stockStatus`, & `country` (`IN` \| `US`) filters and `priceSummary` |
| `GET` | `/api/v1/products/:id` | All Active Admin Roles | Full product detail with category, variants (`prices` by country `IN`/`US`), unified `media` (images & videos), certificate & shipping |
| `POST` | `/api/v1/products` | `super_admin`, `catalog_manager` | Single-page product creation with regional `IN`/`US` pricing (Save Draft or Publish; JSON or `multipart/form-data` with `media` & `certificate`) |
| `PATCH` | `/api/v1/products/:id` | `super_admin`, `catalog_manager` | Update product metadata, specifications, variant options & variants (including `IN`/`US` `prices`) |
| `PATCH` | `/api/v1/products/:id/status` | `super_admin`, `catalog_manager` | Transition product status (`draft`, `active`, `archived`) with publish validation |
| `PATCH` | `/api/v1/products/:id/variants/:variantId/stock` | `super_admin`, `catalog_manager`, `operations_manager` | Update variant stock quantity, low-stock threshold, or active toggle |
| `DELETE` | `/api/v1/products/:id` | `super_admin`, `catalog_manager` | Soft-delete product & variants and clean up Cloudinary media (`image` / `video`) & certificate |
| `POST` | `/api/v1/products/:id/media` | `super_admin`, `catalog_manager` | Upload product gallery images & short videos (`japaika-ecom/products`, max 10 per product) |
| `PATCH` | `/api/v1/products/:id/media/:mediaId` | `super_admin`, `catalog_manager` | Update media `altText`, `sortOrder`, or set `isPrimary: true` (images only) |
| `DELETE` | `/api/v1/products/:id/media/:mediaId` | `super_admin`, `catalog_manager` | Delete product media item & auto-promote primary image |
| `PUT` | `/api/v1/products/:id/certificate` | `super_admin`, `catalog_manager` | Upload or replace product certificate (image or PDF in `japaika-ecom/certificates`) |
| `DELETE` | `/api/v1/products/:id/certificate` | `super_admin`, `catalog_manager` | Remove product certificate & delete Cloudinary asset |
| `GET` | `/api/v1/banners` | All Active Admin Roles | List homepage banners with pagination, search, placement, active & scheduleStatus filters |
| `GET` | `/api/v1/banners/:id` | All Active Admin Roles | Get single banner details including desktop/mobile images & schedule status |
| `POST` | `/api/v1/banners` | `super_admin`, `catalog_manager` | Create banner (`multipart/form-data` with required `image` & optional `mobileImage` in `japaika-ecom/banners`) |
| `PATCH` | `/api/v1/banners/reorder` | `super_admin`, `catalog_manager` | Atomically update `sortOrder` across multiple banners in one transaction |
| `PATCH` | `/api/v1/banners/:id` | `super_admin`, `catalog_manager` | Update banner metadata, schedule, CTA, or replace/remove Cloudinary desktop/mobile images |
| `PATCH` | `/api/v1/banners/:id/status` | `super_admin`, `catalog_manager` | Toggle banner `isActive` status |
| `DELETE` | `/api/v1/banners/:id` | `super_admin`, `catalog_manager` | Soft-delete banner & clean up desktop/mobile Cloudinary images |
| `GET` | `/api/v1/coupons` | All Active Admin Roles | List coupons with pagination, search, `visibility` (`public` \| `hidden`), `isActive`, & `status` filters |
| `GET` | `/api/v1/coupons/:id` | All Active Admin Roles | Get single coupon details including regional `INR`/`USD` thresholds |
| `POST` | `/api/v1/coupons` | `super_admin`, `catalog_manager` | Create percentage coupon (mandatory `INR`/`USD` minimums, optional paired caps, limit, expiry, & `public` \| `hidden` visibility) |
| `PATCH` | `/api/v1/coupons/:id` | `super_admin`, `catalog_manager` | Update coupon configuration (locks `code` once `redemptionCount > 0`) |
| `PATCH` | `/api/v1/coupons/:id/status` | `super_admin`, `catalog_manager` | Activate or deactivate coupon (`isActive`) |
| `DELETE` | `/api/v1/coupons/:id` | `super_admin`, `catalog_manager` | Soft-delete coupon (`isActive = false`, `deleted_at = NOW()`) |
