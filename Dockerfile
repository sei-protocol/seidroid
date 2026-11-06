FROM node:24.22.2-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
