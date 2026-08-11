# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# git est requis pour la publication de la carte ; le job échoue tôt et
# clairement s'il manque, plutôt qu'après une collecte complète.
RUN apk add --no-cache git ca-certificates

COPY package*.json ./
# `cytoscape` reste en dépendance de production : le viewer inline son bundle
# depuis node_modules au moment du rendu.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app

ENTRYPOINT ["node", "dist/index.js"]
