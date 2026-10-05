# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
WORKDIR /app

# Development: full deps, source bind-mounted by compose, hot reload
FROM base AS dev
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "start:dev"]

FROM base AS build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Production: compiled output and prod deps only
FROM base AS prod
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package*.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
