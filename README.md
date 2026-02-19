# Backend API Setup

## Prerequisites

1. **Neon PostgreSQL Account**
   - Sign up at [neon.tech](https://neon.tech)
   - Create a new project
   - Copy the connection string

2. **Node.js** (v18 or higher)

## Setup Instructions

### 1. Install Dependencies

```bash
cd backend-api
npm install
```

### 2. Configure Environment Variables

Edit `.env` file:

```env
DATABASE_URL="postgresql://username:password@ep-xxx-xxx.us-east-1.aws.neon.tech/neondb?sslmode=require"
JWT_SECRET="your-super-secret-jwt-key"
PORT=3001
# Optional: comma-separated list of allowed browser origins (exact matches).
# Localhost (localhost/127.0.0.1) is always allowed for development.
# CORS_ORIGINS="https://admin.example.com,https://staging-admin.example.com"
CORS_ORIGINS=""
# Optional: set to 1 to enable extra auth debug logging
DEBUG_AUTH=0
```

Replace the `DATABASE_URL` with your actual Neon connection string.

### 3. Generate Prisma Client

```bash
npm run db:generate
```

### 4. Push Schema to Database

```bash
npm run db:push
```

### 5. Migrate JSON Data (One-time)

```bash
npm run migrate
```

This will transfer all your existing JSON data to the PostgreSQL database.

### 6. Start the Server

Development:
```bash
npm run dev
```

Production:
```bash
npm start
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login (returns `{ token, user }`)
- `GET /api/auth/me` - Get current user (requires auth; returns `{ user }`)

#### Auth caching behavior
Auth responses are sent with `Cache-Control: no-store` and ETags are disabled to prevent `304 Not Modified` responses (which can cause client-side auth bugs on refresh).

### Products
- `GET /api/products` - List all products
- `GET /api/products/:id` - Get single product
- `POST /api/products` - Create product (requires auth)
- `PUT /api/products/:id` - Update product (requires auth)
- `DELETE /api/products/:id` - Delete product (requires auth)

### Categories
- `GET /api/categories` - List all categories with products
- `POST /api/categories` - Create category (requires auth)
- `PUT /api/categories/:id` - Update category (requires auth)
- `DELETE /api/categories/:id` - Delete category (requires auth)

### Orders
- `GET /api/orders` - List all orders (requires auth)
- `POST /api/orders` - Create order
- `PUT /api/orders/:id` - Update order (requires auth)

### Customers
- `GET /api/customers` - List all customers (requires auth)

### Settings
- `GET /api/settings` - Get settings
- `PUT /api/settings` - Update settings (requires auth)

### Delivery
- `GET /api/delivery` - Get delivery settings
- `PUT /api/delivery` - Update delivery settings (requires auth)

## Database Schema

### Models

- **Category** - Product categories
- **Product** - Products with variants
- **Variant** - Product variants (color, size, etc.)
- **Customer** - Customer information
- **Order** - Orders
- **OrderItem** - Items within orders
- **AdminUser** - Admin users
- **Settings** - Store settings
- **DeliverySettings** - Delivery configuration
- **DeliveryRegion** - Delivery regions by pincode

## Useful Commands

```bash
# Open Prisma Studio (database GUI)
npm run db:studio

# Create a migration
npm run db:migrate -- --name your_migration_name

# Reset database (careful!)
npx prisma migrate reset
```

## Default Admin Credentials

Create an admin user by running the seed script with environment variables:

```bash
cd backend-api

# DIRECT_URL should point to your Neon/PG direct connection string
export DIRECT_URL="postgresql://..."
export ADMIN_EMAIL="admin@example.com"
export ADMIN_USERNAME="Admin"
export ADMIN_ROLE="super_admin"
export ADMIN_PASSWORD="set-a-strong-password"

node scripts/seed-admin.js
```

## Production notes (security)
- Set a strong, stable `JWT_SECRET` in `.env` (do not rely on defaults).
- Restrict CORS via `CORS_ORIGINS` to your real admin domain(s) instead of allowing all origins.
