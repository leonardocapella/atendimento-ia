FROM node:24.11.1-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY db-down ./db-down
COPY seeds ./seeds
COPY config ./config
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
