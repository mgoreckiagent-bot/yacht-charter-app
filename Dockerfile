FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY server.js .
COPY public/ ./public/
COPY fonts/ ./fonts/

EXPOSE 3000

CMD ["npm", "start"]
