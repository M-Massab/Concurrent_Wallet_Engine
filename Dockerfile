FROM node:20-alpine

WORKDIR /app

# Install deps first (layer-cached unless package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "src/app.js"]
