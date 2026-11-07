# Build stage: install everything, compile TypeScript, then drop dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: only the compiled CLI and production dependencies.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# Mount your inputs at /data; relative paths in arguments resolve from there.
WORKDIR /data
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
