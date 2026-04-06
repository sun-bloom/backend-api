# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Node.js backend with a single runtime entrypoint at `server.js`. Database schema and migration history live under `prisma/`, with models in `prisma/schema.prisma`. Operational scripts are in `scripts/`, including `scripts/migrate.js` for JSON-to-Postgres migration and `scripts/seed-admin.js` for bootstrapping an admin user. There is no `src/` split yet, so keep new modules close to the code they support.

## Build, Test, and Development Commands
Use `npm install` to install dependencies and trigger `prisma generate` via `postinstall`. Run `npm run dev` for local development with `nodemon`, or `npm start` for a production-like launch. Database workflows:

- `npm run db:generate` regenerates the Prisma client.
- `npm run db:push` syncs schema changes to the configured database without a migration.
- `npm run db:migrate -- --name add_feature` creates and applies a development migration.
- `npm run migrate` imports legacy JSON data through `scripts/migrate.js`.
- `node scripts/seed-admin.js` creates an admin user from `DIRECT_URL` and `ADMIN_*` env vars.

## Coding Style & Naming Conventions
The codebase uses CommonJS (`require(...)`) and consistent 2-space indentation. Prefer `const`, semicolons, and small helper functions for repeated mapping or validation logic, matching `server.js`. Use camelCase for variables and functions, PascalCase for Prisma models, and kebab-case for script filenames. No formatter or linter is configured, so keep diffs minimal and align with the surrounding file instead of introducing a new style.

## Testing Guidelines
No automated test framework is checked in yet. Validate changes by running `npm run dev`, exercising the affected endpoints, and verifying Prisma operations against a development database. For schema changes, run `npm run db:generate` and the appropriate Prisma migration command before submitting. If you add tests, place them under `tests/` and name them after the target module, for example `orders.test.js`.

## Commit & Pull Request Guidelines
Recent commits use short summaries such as `added: post-install` and `removed: api-docs`; keep commit messages concise, lowercase is acceptable, and scope a single change per commit where practical. Pull requests should explain the behavior change, note any database or environment-variable impact, and include manual verification steps. Link the relevant issue when one exists, and attach request/response examples for API changes.

## Security & Configuration Tips
Store secrets in `.env` only; never commit `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, or admin credentials. Restrict `CORS_ORIGINS` to trusted frontends outside local development, and use `DEBUG_AUTH=0` unless you are actively diagnosing authentication behavior.
