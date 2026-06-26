# Multi-stage build for the QueueStorm Complaint Investigator.
# Produces a slim image based on the official Bun runtime.

# ---- Build stage ----
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./

# ---- Runtime stage ----
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy only what's needed at runtime.
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./

EXPOSE 3000

# Bun runs TypeScript directly; no compile step needed.
CMD ["bun", "run", "src/index.ts"]