# hindsight-mcp -- universal MCP server for Hindsight
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src

RUN npm install && npm run build

FROM node:22-alpine
WORKDIR /app

# Non-root
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S -G app app

COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

USER app

EXPOSE 3852
CMD ["node", "dist/server.js"]
